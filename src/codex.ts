import path from 'node:path'
import TOML from '@iarna/toml'
import { z } from 'zod'
import { API_KEY_ENV_VAR, Err, Ok, PROVIDER_ID, TIER_MODEL, TIERS, type EditError, type GatewayConfig, type Result, type Tier, type ToolStatus } from './domain.js'

const BEGIN = '# >>> agent-helper-internal (managed, do not edit) >>>'
const END = '# <<< agent-helper-internal <<<'
const PROFILE_MARKER = '# managed by agent-helper-internal'

export const profileName = (tier: Tier): string => `llm-${tier}`

/** Codex >= 0.134 reads `--profile NAME` from `<CODEX_HOME>/NAME.config.toml` (no `[profiles.*]`, no `profile =`). */
export const profilePath = (codexHome: string, tier: Tier): string => path.join(codexHome, `${profileName(tier)}.config.toml`)

/** Codex appends `/responses` to base_url, so the OpenAI-style root must end in `/v1`. */
export const codexBaseUrl = (cfg: GatewayConfig): string => `${cfg.baseUrl}/v1`

export function providerBlock(cfg: GatewayConfig): string {
  return [
    BEGIN,
    `[model_providers.${PROVIDER_ID}]`,
    `name = "llm-proxy"`,
    `base_url = ${JSON.stringify(codexBaseUrl(cfg))}`,
    `env_key = ${JSON.stringify(API_KEY_ENV_VAR)}`,
    `wire_api = "responses"`,
    `requires_openai_auth = false`,
    END,
  ].join('\n')
}

export function profileContent(tier: Tier): string {
  return [
    PROFILE_MARKER,
    `model_provider = ${JSON.stringify(PROVIDER_ID)}`,
    `model = ${JSON.stringify(TIER_MODEL[tier])}`,
    '',
  ].join('\n')
}

/** A profile file may be (re)written only if absent, empty, or previously written by this tool. */
export function canWriteProfile(existing: string | undefined): boolean {
  return existing === undefined || existing.trim() === '' || existing.startsWith(PROFILE_MARKER)
}

type BlockSpan = Readonly<{ start: number; end: number }>

function findBlock(text: string): BlockSpan | undefined {
  const start = text.indexOf(BEGIN)
  if (start === -1) return undefined
  const endMarker = text.indexOf(END, start)
  if (endMarker === -1) return undefined
  return { start, end: endMarker + END.length }
}

const TomlRootSchema = z.record(z.string(), z.unknown())

function parseToml(text: string): Result<Record<string, unknown>, EditError> {
  try {
    const root = TomlRootSchema.safeParse(TOML.parse(text))
    return root.success ? Ok(root.data) : Err({ kind: 'unparseable', detail: 'config root is not a table' })
  } catch (e) {
    return Err({ kind: 'unparseable', detail: e instanceof Error ? e.message : 'invalid TOML' })
  }
}

/** Sets or replaces a top-level key, keeping it above the first table header (or the managed block). */
function setTopLevelKey(text: string, key: string, value: string): string {
  const line = `${key} = ${JSON.stringify(value)}`
  const firstTable = text.search(/^\s*\[/m)
  const block = text.indexOf(BEGIN)
  const cut = [firstTable, block].filter((i) => i >= 0).reduce((a, b) => Math.min(a, b), text.length)
  const head = text.slice(0, cut)
  const tail = text.slice(cut)
  const existing = new RegExp(`^${key}\\s*=.*$`, 'm')
  if (existing.test(head)) return head.replace(existing, line) + tail
  const sep = head === '' || head.endsWith('\n') ? '' : '\n'
  return `${head}${sep}${line}\n${tail === '' || head.endsWith('\n\n') ? '' : '\n'}${tail}`
}

export type CodexOptions = Readonly<{ makeDefault: boolean }>

/**
 * Pure: new config.toml text with the provider block and, with `makeDefault`, top-level model_provider/model.
 * Never touches user comments or other tables.
 */
export function applyCodexConfig(text: string, cfg: GatewayConfig, opts: CodexOptions): Result<string, EditError> {
  const existing = findBlock(text)
  const without = existing === undefined ? text : text.slice(0, existing.start).trimEnd() + text.slice(existing.end)
  const parsed = parseToml(without)
  if (!parsed.ok) return parsed
  const providers = parsed.value['model_providers']
  if (typeof providers === 'object' && providers !== null && PROVIDER_ID in providers) {
    return Err({ kind: 'conflict', detail: `[model_providers.${PROVIDER_ID}] already exists outside the managed block` })
  }
  const body = without.trimEnd()
  let next = `${body}${body === '' ? '' : '\n\n'}${providerBlock(cfg)}\n`
  if (opts.makeDefault) {
    next = setTopLevelKey(next, 'model', TIER_MODEL.normal)
    next = setTopLevelKey(next, 'model_provider', PROVIDER_ID)
  }
  const verify = parseToml(next)
  return verify.ok ? Ok(next) : verify
}

export type CodexFiles = Readonly<{ config: string | undefined; profiles: Readonly<Record<Tier, string | undefined>> }>

export function detectCodex(files: CodexFiles, cfg: GatewayConfig): Result<ToolStatus, EditError> {
  if (files.config === undefined || findBlock(files.config) === undefined) return Ok({ state: 'not_configured' })
  const parsed = parseToml(files.config)
  if (!parsed.ok) return parsed
  const providers = z.record(z.string(), z.object({ base_url: z.unknown() }).passthrough()).safeParse(parsed.value['model_providers'])
  const current = providers.success ? providers.data[PROVIDER_ID]?.base_url : undefined
  if (current !== codexBaseUrl(cfg)) return Ok({ state: 'foreign', current: String(current) })
  const missing = TIERS.filter((t) => files.profiles[t] !== profileContent(t)).map((t) => `${profileName(t)}.config.toml`)
  return Ok(missing.length === 0 ? { state: 'configured' } : { state: 'partial', missing })
}
