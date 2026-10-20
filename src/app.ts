import path from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { restoreBackup, writeWithBackup, type FsPort, type PlannedFile } from './backup.js'
import { applyClaudeSettings, detectClaude } from './claude.js'
import { applyCodexConfig, canWriteProfile, detectCodex, profileContent, profileName, profilePath } from './codex.js'
import {
  API_KEY_ENV_VAR, ApiKey, BaseUrl, DEFAULT_BASE_URL, Err, Ok, TIERS, TIER_MODEL, TOOLS, assertNever, redactKey,
  type GatewayConfig, type Result, type Tool, type ToolStatus,
} from './domain.js'
import { fetchTiers, type FetchFn, type GatewayError } from './gateway.js'

const EnvSchema = z.object({
  LLM_PROXY_API_KEY: z.string().optional(),
  LLM_PROXY_BASE_URL: z.string().optional(),
  CLAUDE_CONFIG_DIR: z.string().optional(),
  CODEX_HOME: z.string().optional(),
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
  out: (line: string) => void
  err: (line: string) => void
}>

const USAGE = `agent-helper-internal — point Claude Code and Codex at the llm-proxy gateway

Usage:
  agent-helper-internal apply <claude|codex|all> [--api-key K] [--base-url U] [--default] [--dry-run] [--no-verify]
  agent-helper-internal status [--api-key K] [--base-url U]
  agent-helper-internal restore <claude|codex> [--snapshot NAME]
  agent-helper-internal models [--api-key K] [--base-url U]

Tiers: auto/high (opus), auto/normal (sonnet), auto/fast (haiku).
Key: --api-key or $${API_KEY_ENV_VAR}. Base URL: --base-url or $LLM_PROXY_BASE_URL (default ${DEFAULT_BASE_URL}).
--default (codex only): also set model_provider/model (auto/normal) as the Codex default; otherwise run \`codex -p ${profileName('high')}|${profileName('normal')}|${profileName('fast')}\`.`

const OPTIONS = {
  'api-key': { type: 'string' },
  'base-url': { type: 'string' },
  snapshot: { type: 'string' },
  default: { type: 'boolean' },
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

function resolveConfig(values: Readonly<{ 'api-key'?: string | undefined; 'base-url'?: string | undefined }>, deps: Deps): GatewayConfig | string {
  const base = BaseUrl(values['base-url'] ?? deps.env.LLM_PROXY_BASE_URL ?? DEFAULT_BASE_URL)
  if (!base.ok) return 'invalid --base-url (expected an http(s) URL)'
  const key = ApiKey(values['api-key'] ?? deps.env.LLM_PROXY_API_KEY ?? '')
  if (!key.ok) return `missing or invalid API key: pass --api-key or export ${API_KEY_ENV_VAR}`
  return { baseUrl: base.value, apiKey: key.value }
}

type Planned = Result<readonly PlannedFile[], string>

async function planClaude(cfg: GatewayConfig, deps: Deps): Promise<Planned> {
  const target = targetPath('claude', deps)
  const next = applyClaudeSettings((await deps.fs.read(target)) ?? '', cfg)
  return next.ok ? Ok([{ target, content: next.value }]) : Err(`cannot edit ${target}: ${next.error.kind} (${next.error.detail})`)
}

async function planCodex(cfg: GatewayConfig, makeDefault: boolean, deps: Deps): Promise<Planned> {
  const target = targetPath('codex', deps)
  const next = applyCodexConfig((await deps.fs.read(target)) ?? '', cfg, { makeDefault })
  if (!next.ok) return Err(`cannot edit ${target}: ${next.error.kind} (${next.error.detail})`)
  const files: PlannedFile[] = [{ target, content: next.value }]
  for (const tier of TIERS) {
    const file = profilePath(codexHome(deps), tier)
    if (!canWriteProfile(await deps.fs.read(file))) return Err(`${file} exists and was not written by this tool; move it away first`)
    files.push({ target: file, content: profileContent(tier) })
  }
  return Ok(files)
}

async function applyOne(tool: Tool, cfg: GatewayConfig, flags: Readonly<{ makeDefault: boolean; dryRun: boolean }>, deps: Deps): Promise<boolean> {
  const planned = tool === 'claude' ? await planClaude(cfg, deps) : await planCodex(cfg, flags.makeDefault, deps)
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
    deps.out(`  export ${API_KEY_ENV_VAR}=<your key>   # Codex reads the key from the environment`)
    deps.out(flags.makeDefault
      ? `  default model: ${TIER_MODEL.normal}; others: codex -p ${profileName('high')} | ${profileName('fast')}`
      : `  run: codex -p ${profileName('high')} | ${profileName('normal')} | ${profileName('fast')}`)
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
    case 'models': {
      const cfg = resolveConfig(values, deps)
      if (typeof cfg === 'string') { deps.err(cfg); return EXIT_USAGE }
      if (command === 'status') return runStatus(cfg, deps)
      if (command === 'models') return runModels(cfg, deps)
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
        const ok = await applyOne(tool, cfg, { makeDefault: values.default === true, dryRun: values['dry-run'] === true }, deps)
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
