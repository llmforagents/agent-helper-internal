import { z } from 'zod'
import { Err, Ok, TIER_MODEL, TIERS, type GatewayConfig, type Result, type Tier } from './domain.js'

export type GatewayError =
  | { readonly kind: 'unauthorized' }
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'network'; readonly message: string }
  | { readonly kind: 'bad_response' }

const ModelsSchema = z.object({ data: z.array(z.object({ id: z.string(), owned_by: z.string().optional() })) })

export type TierInfo = Readonly<{ tier: Tier; model: string; members: string }>

const TIMEOUT_MS = 10_000

/** Port: lets tests stub the network. */
export type FetchFn = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>

/** GET /v1/models: validates the key and reports which tiers the gateway can serve right now. */
export async function fetchTiers(fetchFn: FetchFn, cfg: GatewayConfig): Promise<Result<readonly TierInfo[], GatewayError>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetchFn(`${cfg.baseUrl}/v1/models`, {
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      signal: controller.signal,
    })
    if (res.status === 401 || res.status === 403) return Err({ kind: 'unauthorized' })
    if (!res.ok) return Err({ kind: 'http', status: res.status })
    const parsed = ModelsSchema.safeParse(await res.json())
    if (!parsed.success) return Err({ kind: 'bad_response' })
    const byId = new Map(parsed.data.data.map((m) => [m.id, m.owned_by ?? ''] as const))
    const infos = TIERS.flatMap((tier): TierInfo[] => {
      const members = byId.get(TIER_MODEL[tier])
      return members === undefined ? [] : [{ tier, model: TIER_MODEL[tier], members }]
    })
    return Ok(infos)
  } catch (e) {
    return Err({ kind: 'network', message: e instanceof Error ? e.message : 'request failed' })
  } finally {
    clearTimeout(timer)
  }
}
