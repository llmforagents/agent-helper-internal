import { applyEdits, modify, parse, type ParseError, printParseErrorCode } from 'jsonc-parser'
import { z } from 'zod'
import { Err, Ok, TIER_MODEL, type EditError, type GatewayConfig, type Result, type ToolStatus } from './domain.js'

/** Claude Code roles → gateway tiers. opus = hardest work, sonnet = default, haiku = background/fast. */
export function claudeEnv(cfg: GatewayConfig): Readonly<Record<string, string>> {
  return {
    ANTHROPIC_BASE_URL: cfg.baseUrl,
    ANTHROPIC_AUTH_TOKEN: cfg.apiKey,
    ANTHROPIC_MODEL: TIER_MODEL.normal,
    ANTHROPIC_DEFAULT_OPUS_MODEL: TIER_MODEL.high,
    ANTHROPIC_DEFAULT_SONNET_MODEL: TIER_MODEL.normal,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: TIER_MODEL.fast,
  }
}

/** Keys managed by this tool; `ANTHROPIC_SMALL_FAST_MODEL` is removed (no longer used by Claude Code). */
const STALE_KEYS = ['ANTHROPIC_SMALL_FAST_MODEL'] as const

const SettingsSchema = z.object({ env: z.record(z.string(), z.unknown()).optional() }).passthrough()

function parseSettings(text: string): Result<z.infer<typeof SettingsSchema>, EditError> {
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true })
  const first = errors[0]
  if (first !== undefined) return Err({ kind: 'unparseable', detail: printParseErrorCode(first.error) })
  const checked = SettingsSchema.safeParse(value ?? {})
  if (!checked.success) return Err({ kind: 'unparseable', detail: checked.error.issues.map((i) => i.message).join('; ') })
  return Ok(checked.data)
}

const FORMAT = { formattingOptions: { insertSpaces: true, tabSize: 2 } } as const

/** Pure: returns the new settings.json text with the gateway env applied, preserving comments and other keys. */
export function applyClaudeSettings(text: string, cfg: GatewayConfig): Result<string, EditError> {
  const base = text.trim() === '' ? '{}' : text
  const parsed = parseSettings(base)
  if (!parsed.ok) return parsed
  let current = base
  for (const [key, value] of Object.entries(claudeEnv(cfg))) {
    current = applyEdits(current, modify(current, ['env', key], value, FORMAT))
  }
  for (const key of STALE_KEYS) {
    if (parsed.value.env !== undefined && key in parsed.value.env) {
      current = applyEdits(current, modify(current, ['env', key], undefined, FORMAT))
    }
  }
  return Ok(current)
}

export function detectClaude(text: string | undefined, cfg: GatewayConfig): Result<ToolStatus, EditError> {
  if (text === undefined || text.trim() === '') return Ok({ state: 'not_configured' })
  const parsed = parseSettings(text)
  if (!parsed.ok) return parsed
  const env = parsed.value.env ?? {}
  const baseUrl = env['ANTHROPIC_BASE_URL']
  if (baseUrl === undefined) return Ok({ state: 'not_configured' })
  if (baseUrl !== cfg.baseUrl) return Ok({ state: 'foreign', current: String(baseUrl) })
  const missing = Object.entries(claudeEnv(cfg))
    .filter(([key, value]) => key !== 'ANTHROPIC_AUTH_TOKEN' ? env[key] !== value : typeof env[key] !== 'string')
    .map(([key]) => key)
  return Ok(missing.length === 0 ? { state: 'configured' } : { state: 'partial', missing })
}
