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
  const keys = head.trimEnd()
  return `${keys}${keys === '' ? '' : '\n'}${line}\n${tail === '' ? '' : `\n${tail.trimStart()}`}`
}

export type CodexOptions = Readonly<{
  makeDefault: boolean
  /** Set `model_catalog_json` to this path (only used when the user has none yet). */
  catalogPath?: string
}>

const CATALOG_CONTEXT_WINDOW = 200_000
/** Lower sorts first in `/model`: the default tier leads. */
const PRIORITY: Record<Tier, number> = { normal: 0, high: 1, fast: 2 }

/**
 * Catalog entry for one tier, so `/model` lists it and Codex has real metadata instead of the fallback.
 * `apply_patch_tool_type` is deliberately omitted: Codex only accepts "freeform" there (a custom tool the gateway's
 * Responses translation does not carry; "function" makes Codex refuse the whole catalog), and without it the model
 * edits files through the regular shell tools, which do work through the gateway.
 */
export function catalogEntry(tier: Tier): Record<string, unknown> {
  const labels: Record<Tier, string> = {
    high: 'llm-proxy high: hardest tasks (opus-class)',
    normal: 'llm-proxy normal: everyday coding (sonnet-class, default)',
    fast: 'llm-proxy fast: quick edits, search and routine work (haiku-class)',
  }
  return {
    slug: TIER_MODEL[tier],
    display_name: TIER_MODEL[tier],
    description: labels[tier],
    default_reasoning_level: 'medium',
    supported_reasoning_levels: [
      { effort: 'low', description: 'Light reasoning' },
      { effort: 'medium', description: 'Balanced reasoning' },
      { effort: 'high', description: 'Enhanced reasoning' },
    ],
    shell_type: 'shell_command',
    visibility: 'list',
    supported_in_api: true,
    priority: PRIORITY[tier],
    base_instructions: '',
    supports_reasoning_summaries: false,
    default_reasoning_summary: 'none',
    support_verbosity: false,
    truncation_policy: { mode: 'bytes', limit: 10000 },
    context_window: CATALOG_CONTEXT_WINDOW,
    max_context_window: CATALOG_CONTEXT_WINDOW,
    effective_context_window_percent: 95,
    supports_parallel_tool_calls: true,
    experimental_supported_tools: [],
    input_modalities: ['text'],
  }
}

const CatalogSchema = z.object({ models: z.array(z.record(z.string(), z.unknown())) }).passthrough()

/** Pure: adds/refreshes the three tier entries in a model catalog, keeping every other entry untouched. */
export function mergeCatalog(text: string | undefined): Result<string, EditError> {
  let json: unknown = { models: [] }
  if (text !== undefined && text.trim() !== '') {
    try {
      json = JSON.parse(text)
    } catch (e) {
      return Err({ kind: 'unparseable', detail: e instanceof Error ? e.message : 'invalid JSON' })
    }
  }
  const parsed = CatalogSchema.safeParse(json)
  if (!parsed.success) return Err({ kind: 'unparseable', detail: 'model catalog must be {"models": [...]}' })
  const ours = TIERS.map(catalogEntry)
  const slugs = new Set(ours.map((e) => e['slug']))
  const others = parsed.data.models.filter((m) => !slugs.has(m['slug']))
  return Ok(JSON.stringify({ ...parsed.data, models: [...ours, ...others] }, null, 2) + '\n')
}

/** Where the model catalog lives: the user's own `model_catalog_json` (with `~` expanded) or undefined. */
export function declaredCatalogPath(configText: string | undefined, codexHome: string, home: string): string | undefined {
  if (configText === undefined) return undefined
  const parsed = parseToml(configText)
  const value = parsed.ok ? parsed.value['model_catalog_json'] : undefined
  if (typeof value !== 'string' || value === '') return undefined
  if (value === '~' || value.startsWith('~/')) return path.join(home, value.slice(1))
  return path.isAbsolute(value) ? value : path.join(codexHome, value)
}

export const defaultCatalogPath = (codexHome: string): string => path.join(codexHome, 'llm-proxy-models.json')

const REVIEW_MODEL_LINE = /^review_model\s*=.*$/m
const SUBAGENT_MODEL_LINE = /^default_subagent_model\s*=.*$/m

/**
 * Keys that name a model for the OLD provider and would be sent to the gateway as-is once it is the default
 * (e.g. review_model = "glm-5.3"): remap them to tiers, but only when the user already set them.
 */
function remapDependentModels(text: string): string {
  const withReview = REVIEW_MODEL_LINE.test(text) ? text.replace(REVIEW_MODEL_LINE, `review_model = ${JSON.stringify(TIER_MODEL.high)}`) : text
  return SUBAGENT_MODEL_LINE.test(withReview)
    ? withReview.replace(SUBAGENT_MODEL_LINE, `default_subagent_model = ${JSON.stringify(TIER_MODEL.fast)}`)
    : withReview
}

/** The provider plain `codex` (no -p) resolves to, from the top-level `model_provider` key. */
export function codexDefaultProvider(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const parsed = parseToml(text)
  const value = parsed.ok ? parsed.value['model_provider'] : undefined
  return typeof value === 'string' ? value : undefined
}

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
    next = remapDependentModels(next)
    if (opts.catalogPath !== undefined) next = setTopLevelKey(next, 'model_catalog_json', opts.catalogPath)
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
