export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export const Ok = <T>(value: T): Result<T, never> => ({ ok: true, value })
export const Err = <E>(error: E): Result<never, E> => ({ ok: false, error })

export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`)
}

type Brand<T, B extends string> = T & { readonly __brand: B }

export type BaseUrl = Brand<string, 'BaseUrl'>
export type ApiKey = Brand<string, 'ApiKey'>

export const DEFAULT_BASE_URL = 'https://llm-proxy-prod.fcorp.workers.dev'

export function BaseUrl(raw: string): Result<BaseUrl, 'invalid_base_url'> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return Err('invalid_base_url')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return Err('invalid_base_url')
  // Gateway root: the Anthropic SDK appends /v1/messages, and Codex needs `<root>/v1` (added in codex.ts).
  const trimmed = url.toString().replace(/\/+$/, '').replace(/\/v1$/, '')
  return Ok(trimmed as BaseUrl)
}

export function ApiKey(raw: string): Result<ApiKey, 'invalid_api_key'> {
  const key = raw.trim()
  if (key.length < 16 || /\s/.test(key)) return Err('invalid_api_key')
  return Ok(key as ApiKey)
}

export function redactKey(key: string): string {
  return key.length <= 8 ? '********' : `${key.slice(0, 4)}…${key.slice(-4)}`
}

export const TIERS = ['high', 'normal', 'fast'] as const
export type Tier = (typeof TIERS)[number]

export const TIER_MODEL: Record<Tier, string> = {
  high: 'auto/high',
  normal: 'auto/normal',
  fast: 'auto/fast',
}

export const TOOLS = ['claude', 'codex'] as const
export type Tool = (typeof TOOLS)[number]

export const API_KEY_ENV_VAR = 'LLM_PROXY_API_KEY'
export const PROVIDER_ID = 'llm-proxy'

export type GatewayConfig = Readonly<{
  baseUrl: BaseUrl
  apiKey: ApiKey
}>

export type ToolStatus =
  | { readonly state: 'not_configured' }
  | { readonly state: 'configured' }
  | { readonly state: 'partial'; readonly missing: readonly string[] }
  | { readonly state: 'foreign'; readonly current: string }

export type EditError =
  | { readonly kind: 'unparseable'; readonly detail: string }
  | { readonly kind: 'conflict'; readonly detail: string }
