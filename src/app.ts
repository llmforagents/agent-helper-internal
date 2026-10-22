import path from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { restoreBackup, writeWithBackup, type FsPort, type PlannedFile } from './backup.js'
import { applyClaudeSettings, detectClaude } from './claude.js'
import { applyCodexConfig, canWriteProfile, codexDefaultProvider, declaredCatalogPath, defaultCatalogPath, detectCodex, mergeCatalog, profileContent, profileName, profilePath } from './codex.js'
import {
  API_KEY_ENV_VAR, ApiKey, BaseUrl, DEFAULT_BASE_URL, Err, Ok, PROVIDER_ID, TIERS, TIER_MODEL, TOOLS, assertNever, redactKey,
  type GatewayConfig, type Result, type Tool, type ToolStatus,
} from './domain.js'
import { keyFilePath } from './keyfile.js'
import { fetchTiers, smokeResponses, type FetchFn, type GatewayError } from './gateway.js'

const EnvSchema = z.object({
  LLM_PROXY_API_KEY: z.string().optional(),
  LLM_PROXY_BASE_URL: z.string().optional(),
  CLAUDE_CONFIG_DIR: z.string().optional(),
  CODEX_HOME: z.string().optional(),
  SHELL: z.string().optional(),
})

export type Env = z.infer<typeof EnvSchema>

export function loadEnv(raw: Readonly<Record<string, string | undefined>>): Env {
  return EnvSchema.parse(raw)
}

export type Deps = Readonly<{
  fs: FsPort
  fetch: FetchFn
  env: Env
  home: string
  now: () => Date
  /** True when stdin/stdout are a TTY, so asking questions is possible. */
  interactive: boolean
  prompt: (question: string, opts: Readonly<{ hidden: boolean }>) => Promise<string>
  out: (line: string) => void
  err: (line: string) => void
}>

const USAGE = `agent-helper-internal — point Claude Code and Codex at the llm-proxy gateway

Usage:
  agent-helper-internal apply <claude|codex|all> [--api-key K] [--base-url U] [--no-default] [--dry-run] [--no-verify]
  agent-helper-internal status [--api-key K] [--base-url U]
  agent-helper-internal restore <claude|codex> [--snapshot NAME]
  agent-helper-internal models [--api-key K] [--base-url U]
  agent-helper-internal doctor [--api-key K] [--base-url U]   # end-to-end checks; run it when something does not work

Tiers: auto/high (opus), auto/normal (sonnet), auto/fast (haiku).
Key: --api-key or $${API_KEY_ENV_VAR}; if neither is set and this is a terminal, you are asked for it (hidden input). Base URL: --base-url or $LLM_PROXY_BASE_URL (default ${DEFAULT_BASE_URL}).
Codex gets the key from a 0600 file (~/.config/agent-helper-internal/api-key) via its provider auth command, so no shell setup or env var is needed.
Codex: by default plain \`codex\` goes through the gateway (model_provider + model = auto/normal; review_model/default_subagent_model are remapped if you set them). \`codex -p ${profileName('high')}|${profileName('normal')}|${profileName('fast')}\` picks a tier. --no-default only adds the profiles and leaves your current default; \`restore codex\` undoes everything.`

const OPTIONS = {
  'api-key': { type: 'string' },
  'base-url': { type: 'string' },
  snapshot: { type: 'string' },
  default: { type: 'boolean' },
  'no-default': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
  'no-verify': { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const

const EXIT_OK = 0
const EXIT_FAIL = 1
const EXIT_USAGE = 2

function describeGatewayError(e: GatewayError): string {
  switch (e.kind) {
    case 'unauthorized': return 'the gateway rejected the API key (401/403)'
    case 'http': return `the gateway answered HTTP ${e.status}`
    case 'network': return `could not reach the gateway: ${e.message}`
    case 'bad_response': return 'the gateway returned an unexpected /v1/models payload'
    default: return assertNever(e)
  }
}

function describeStatus(s: ToolStatus): string {
  switch (s.state) {
    case 'not_configured': return 'not configured'
    case 'configured': return 'configured'
    case 'partial': return `partial (missing: ${s.missing.join(', ')})`
    case 'foreign': return `points elsewhere (${s.current})`
    default: return assertNever(s)
  }
}

const codexHome = (deps: Deps): string => deps.env.CODEX_HOME ?? path.join(deps.home, '.codex')

function targetPath(tool: Tool, deps: Deps): string {
  switch (tool) {
    case 'claude': return path.join(deps.env.CLAUDE_CONFIG_DIR ?? path.join(deps.home, '.claude'), 'settings.json')
    case 'codex': return path.join(codexHome(deps), 'config.toml')
    default: return assertNever(tool)
  }
}

async function resolveConfig(
  values: Readonly<{ 'api-key'?: string | undefined; 'base-url'?: string | undefined }>,
  deps: Deps,
  opts: Readonly<{ mayPrompt: boolean }>,
): Promise<GatewayConfig | string> {
  const base = BaseUrl(values['base-url'] ?? deps.env.LLM_PROXY_BASE_URL ?? DEFAULT_BASE_URL)
  if (!base.ok) return 'invalid --base-url (expected an http(s) URL)'
  let raw = values['api-key'] ?? deps.env.LLM_PROXY_API_KEY ?? ''
  // `status` only inspects files; it never needs a real key.
  if (raw.trim() === '' && !opts.mayPrompt) raw = 'status-placeholder-key'
  if (raw.trim() === '' && opts.mayPrompt && deps.interactive) {
    raw = await deps.prompt('LLM proxy API key (input hidden): ', { hidden: true })
  }
  const key = ApiKey(raw)
  if (!key.ok) return `missing or invalid API key: pass --api-key, export ${API_KEY_ENV_VAR}, or run in a terminal to be asked`
  return { baseUrl: base.value, apiKey: key.value }
}

type Planned = Result<readonly PlannedFile[], string>

async function planClaude(cfg: GatewayConfig, deps: Deps): Promise<Planned> {
  const target = targetPath('claude', deps)
  const next = applyClaudeSettings((await deps.fs.read(target)) ?? '', cfg)
  return next.ok ? Ok([{ target, content: next.value }]) : Err(`cannot edit ${target}: ${next.error.kind} (${next.error.detail})`)
}

async function planCodex(cfg: GatewayConfig, flags: Readonly<{ makeDefault: boolean }>, deps: Deps): Promise<Planned> {
  const target = targetPath('codex', deps)
  const current = (await deps.fs.read(target)) ?? ''
  // Keep the user's own catalog when they have one; otherwise create ours, but only when the gateway becomes the default.
  const declared = declaredCatalogPath(current, codexHome(deps), deps.home)
  const catalogPath = declared ?? (flags.makeDefault ? defaultCatalogPath(codexHome(deps)) : undefined)
  const next = applyCodexConfig(current, cfg, {
    makeDefault: flags.makeDefault,
    keyFile: keyFilePath(deps.home),
    ...(declared === undefined && catalogPath !== undefined ? { catalogPath } : {}),
  })
  if (!next.ok) return Err(`cannot edit ${target}: ${next.error.kind} (${next.error.detail})`)
  const files: PlannedFile[] = [{ target, content: next.value }]
  if (catalogPath !== undefined) {
    const catalog = mergeCatalog(await deps.fs.read(catalogPath))
    if (!catalog.ok) return Err(`cannot edit ${catalogPath}: ${catalog.error.kind} (${catalog.error.detail})`)
    files.push({ target: catalogPath, content: catalog.value })
  }
  for (const tier of TIERS) {
    const file = profilePath(codexHome(deps), tier)
    if (!canWriteProfile(await deps.fs.read(file))) return Err(`${file} exists and was not written by this tool; move it away first`)
    files.push({ target: file, content: profileContent(tier) })
  }
  files.push({ target: keyFilePath(deps.home), content: cfg.apiKey })
  return Ok(files)
}

type ApplyFlags = Readonly<{ makeDefault: boolean; dryRun: boolean }>

async function applyOne(tool: Tool, cfg: GatewayConfig, flags: ApplyFlags, deps: Deps): Promise<boolean> {
  const planned = tool === 'claude' ? await planClaude(cfg, deps) : await planCodex(cfg, { makeDefault: flags.makeDefault }, deps)
  if (!planned.ok) {
    deps.err(`${tool}: ${planned.error}`)
    return false
  }
  const changed: PlannedFile[] = []
  for (const file of planned.value) {
    if ((await deps.fs.read(file.target)) !== file.content) changed.push(file)
  }
  if (changed.length === 0) {
    deps.out(`${tool}: already up to date`)
    return true
  }
  const names = changed.map((f) => f.target).join(', ')
  if (flags.dryRun) {
    deps.out(`${tool}: would update ${names} (dry run)`)
    return true
  }
  const snapshot = await writeWithBackup(deps.fs, { home: deps.home, tool, files: changed, now: deps.now() })
  deps.out(`${tool}: updated ${names} (backup ${snapshot})`)
  if (tool === 'codex') {
    deps.out(`  key stored in ${keyFilePath(deps.home)} (0600); Codex reads it through its provider auth command, no env var needed`)
    deps.out(flags.makeDefault
      ? `  plain \`codex\` now uses ${TIER_MODEL.normal} via the gateway (restart open Codex sessions); tiers: codex -p ${profileName('high')} | ${profileName('fast')}\n  if /model still lists old models: Codex's background server caches them; run \`codex app-server daemon restart\` (it interrupts running Codex sessions)`
      : `  your default is unchanged; run: codex -p ${profileName('high')} | ${profileName('normal')} | ${profileName('fast')}`)
  } else {
    deps.out('  restart open Claude Code sessions to pick up the new env')
  }
  return true
}

export async function run(argv: readonly string[], deps: Deps): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>
  try {
    parsed = parseArgs({ args: [...argv], options: OPTIONS, allowPositionals: true })
  } catch (e) {
    deps.err(e instanceof Error ? e.message : 'invalid arguments')
    deps.err(USAGE)
    return EXIT_USAGE
  }
  const [command, arg] = parsed.positionals
  const { values } = parsed
  if (values.help === true || command === undefined) {
    deps.out(USAGE)
    return command === undefined && values.help !== true ? EXIT_USAGE : EXIT_OK
  }

  switch (command) {
    case 'restore': {
      const tool = TOOLS.find((t) => t === arg)
      if (tool === undefined) { deps.err(`restore needs a tool: ${TOOLS.join('|')}`); return EXIT_USAGE }
      const r = await restoreBackup(deps.fs, { home: deps.home, tool, ...(values.snapshot !== undefined ? { snapshot: values.snapshot } : {}) })
      if (!r.ok) { deps.err(`${tool}: ${r.error.kind === 'no_backup' ? 'no backup found' : `backup ${r.error.snapshot} is corrupt`}`); return EXIT_FAIL }
      deps.out(`${tool}: restored from backup ${r.value}`)
      return EXIT_OK
    }
    case 'apply':
    case 'status':
    case 'models':
    case 'doctor': {
      const cfg = await resolveConfig(values, deps, { mayPrompt: command !== 'status' })
      if (typeof cfg === 'string') { deps.err(cfg); return EXIT_USAGE }
      if (command === 'status') return runStatus(cfg, deps)
      if (command === 'models') return runModels(cfg, deps)
      if (command === 'doctor') return runDoctor(cfg, deps)
      const tools = arg === 'all' ? TOOLS : TOOLS.filter((t) => t === arg)
      if (tools.length === 0) { deps.err(`apply needs a tool: ${TOOLS.join('|')}|all`); return EXIT_USAGE }
      if (values['no-verify'] !== true) {
        const tiers = await fetchTiers(deps.fetch, cfg)
        if (!tiers.ok) { deps.err(`verification failed: ${describeGatewayError(tiers.error)} (use --no-verify to skip)`); return EXIT_FAIL }
        const missing = TIERS.filter((t) => !tiers.value.some((i) => i.tier === t))
        if (missing.length > 0) deps.err(`warning: gateway does not list tier(s): ${missing.map((t) => `auto/${t}`).join(', ')}`)
      }
      deps.out(`gateway ${cfg.baseUrl}  key ${redactKey(cfg.apiKey)}`)
      let allOk = true
      for (const tool of tools) {
        const ok = await applyOne(tool, cfg, { makeDefault: values['no-default'] !== true, dryRun: values['dry-run'] === true }, deps)
        allOk = allOk && ok
      }
      return allOk ? EXIT_OK : EXIT_FAIL
    }
    default:
      deps.err(`unknown command: ${command}`)
      deps.err(USAGE)
      return EXIT_USAGE
  }
}

async function runStatus(cfg: GatewayConfig, deps: Deps): Promise<number> {
  for (const tool of TOOLS) {
    const status = tool === 'claude'
      ? detectClaude(await deps.fs.read(targetPath('claude', deps)), cfg)
      : detectCodex({
          config: await deps.fs.read(targetPath('codex', deps)),
          profiles: {
            high: await deps.fs.read(profilePath(codexHome(deps), 'high')),
            normal: await deps.fs.read(profilePath(codexHome(deps), 'normal')),
            fast: await deps.fs.read(profilePath(codexHome(deps), 'fast')),
          },
        }, cfg)
    deps.out(`${tool}: ${status.ok ? describeStatus(status.value) : `unreadable (${status.error.detail})`}`)
  }
  return EXIT_OK
}

async function runModels(cfg: GatewayConfig, deps: Deps): Promise<number> {
  const tiers = await fetchTiers(deps.fetch, cfg)
  if (!tiers.ok) { deps.err(describeGatewayError(tiers.error)); return EXIT_FAIL }
  for (const t of tiers.value) deps.out(`${t.model.padEnd(12)} → ${t.members}`)
  return EXIT_OK
}

type Check = Readonly<{ ok: boolean; line: string }>

/** Everything that has to be true for `codex -p llm-*` and Claude Code to reach the gateway, each with its fix. */
async function runDoctor(cfg: GatewayConfig, deps: Deps): Promise<number> {
  const checks: Check[] = []

  const claude = detectClaude(await deps.fs.read(targetPath('claude', deps)), cfg)
  checks.push({
    ok: claude.ok && claude.value.state === 'configured',
    line: `Claude Code config: ${claude.ok ? describeStatus(claude.value) : `unreadable (${claude.error.detail})`}${claude.ok && claude.value.state === 'configured' ? '' : `  -> run: agent-helper-internal apply claude`}`,
  })

  const codex = detectCodex({
    config: await deps.fs.read(targetPath('codex', deps)),
    profiles: {
      high: await deps.fs.read(profilePath(codexHome(deps), 'high')),
      normal: await deps.fs.read(profilePath(codexHome(deps), 'normal')),
      fast: await deps.fs.read(profilePath(codexHome(deps), 'fast')),
    },
  }, cfg)
  checks.push({
    ok: codex.ok && codex.value.state === 'configured',
    line: `Codex config: ${codex.ok ? describeStatus(codex.value) : `unreadable (${codex.error.detail})`}${codex.ok && codex.value.state === 'configured' ? '' : `  -> run: agent-helper-internal apply codex`}`,
  })

  const stored = (await deps.fs.read(keyFilePath(deps.home)))?.trim() ?? ''
  checks.push({
    ok: stored !== '',
    line: stored === ''
      ? `Codex key file ${keyFilePath(deps.home)} is missing or empty  -> run: agent-helper-internal apply codex`
      : stored === cfg.apiKey
        ? 'Codex key file matches the key being checked (read through the provider auth command, no env var needed)'
        : 'Codex key file holds a different key than the one being checked  -> run: agent-helper-internal apply codex with the right key',
  })
  const defaultProvider = codexDefaultProvider(await deps.fs.read(targetPath('codex', deps)))
  checks.push({
    ok: defaultProvider === PROVIDER_ID,
    line: defaultProvider === PROVIDER_ID
      ? 'Plain `codex` uses the gateway (model_provider = llm-proxy)'
      : `Plain \`codex\` still uses provider "${defaultProvider ?? 'OpenAI default'}"  -> run: agent-helper-internal apply codex  (or use \`codex -p ${profileName('normal')}\`)`,
  })

  const tiers = await fetchTiers(deps.fetch, cfg)
  checks.push({
    ok: tiers.ok && tiers.value.length === TIERS.length,
    line: tiers.ok
      ? `Gateway tiers: ${tiers.value.map((t) => t.model).join(', ') || 'none'}${tiers.value.length === TIERS.length ? '' : '  (a tier is missing)'}`
      : `Gateway /v1/models: ${describeGatewayError(tiers.error)}`,
  })
  const smoke = await smokeResponses(deps.fetch, cfg)
  checks.push({
    ok: smoke.ok,
    line: smoke.ok ? 'Gateway /v1/responses (the wire Codex uses): ok' : `Gateway /v1/responses: ${describeGatewayError(smoke.error)}`,
  })

  for (const c of checks) deps.out(`${c.ok ? '[ok]  ' : '[FAIL]'} ${c.line}`)
  return checks.every((c) => c.ok) ? EXIT_OK : EXIT_FAIL
}
