import TOML from '@iarna/toml'
import { describe, expect, it } from 'vitest'
import { applyCodexConfig, canWriteProfile, codexDefaultProvider, detectCodex, profileContent, profilePath } from '../src/codex.js'
import { testConfig } from './helpers.js'

const cfg = testConfig()
const USER = 'model_provider = "ZAI"\nmodel = "glm"\n# keep me\n\n[model_providers.ZAI]\nname = "ZAI"\nbase_url = "https://z.ai"\n'

function ok(text: string, makeDefault = false): string {
  const r = applyCodexConfig(text, cfg, { makeDefault })
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.detail}`)
  return r.value
}

describe('applyCodexConfig', () => {
  it('adds the provider with base_url ending in /v1 and the responses wire API', () => {
    const parsed = TOML.parse(ok(USER)) as any
    expect(parsed.model_providers['llm-proxy']).toMatchObject({
      base_url: 'https://gw.example/v1', wire_api: 'responses', env_key: 'LLM_PROXY_API_KEY', requires_openai_auth: false,
    })
  })
  it('does not use the legacy [profiles.*] tables Codex >= 0.134 rejects', () => {
    const out = ok(USER, true)
    expect(out).not.toMatch(/\[profiles\./)
    expect(out).not.toMatch(/^profile\s*=/m)
  })
  it('never writes the API key and leaves the user config untouched by default', () => {
    const out = ok(USER)
    expect(out).not.toContain('k'.repeat(32))
    expect(out.startsWith(USER.trimEnd())).toBe(true)
    expect((TOML.parse(out) as any).model_provider).toBe('ZAI')
  })
  it('--default replaces top-level model_provider/model and keeps them above every table', () => {
    const parsed = TOML.parse(ok(USER, true)) as any
    expect(parsed.model_provider).toBe('llm-proxy')
    expect(parsed.model).toBe('auto/normal')
    expect(parsed.model_providers.ZAI.base_url).toBe('https://z.ai')
  })
  it('--default on an empty config inserts the keys above the managed block', () => {
    const out = ok('', true)
    expect(out.indexOf('model_provider')).toBeLessThan(out.indexOf('>>>'))
    expect((TOML.parse(out) as any).model).toBe('auto/normal')
  })
  it('is idempotent and replaces the managed block on re-apply', () => {
    const once = ok(USER, true)
    expect(ok(once, true)).toBe(once)
  })
  it('refuses to clobber a provider the user defined by hand', () => {
    expect(applyCodexConfig('[model_providers.llm-proxy]\nname="x"\n', cfg, { makeDefault: false }).ok).toBe(false)
  })
  it('rejects invalid TOML', () => {
    expect(applyCodexConfig('model = ', cfg, { makeDefault: false }).ok).toBe(false)
  })
})

describe('profile files', () => {
  it('map tiers to <name>.config.toml with top-level keys', () => {
    expect(profilePath('/c', 'high')).toBe('/c/llm-high.config.toml')
    const parsed = TOML.parse(profileContent('fast')) as any
    expect(parsed).toEqual({ model_provider: 'llm-proxy', model: 'auto/fast' })
  })
  it('only overwrites files this tool wrote', () => {
    expect(canWriteProfile(undefined)).toBe(true)
    expect(canWriteProfile(profileContent('high'))).toBe(true)
    expect(canWriteProfile('model = "mine"\n')).toBe(false)
  })
})

describe('detectCodex', () => {
  const profiles = { high: profileContent('high'), normal: profileContent('normal'), fast: profileContent('fast') }
  it('detects not_configured, partial and configured', () => {
    expect(detectCodex({ config: USER, profiles: { high: undefined, normal: undefined, fast: undefined } }, cfg))
      .toEqual({ ok: true, value: { state: 'not_configured' } })
    const config = ok(USER)
    const partial = detectCodex({ config, profiles: { ...profiles, fast: undefined } }, cfg)
    expect(partial.ok && partial.value.state).toBe('partial')
    expect(detectCodex({ config, profiles }, cfg)).toEqual({ ok: true, value: { state: 'configured' } })
  })
})

describe('default provider switch', () => {
  const ZAI_CFG = 'model_provider = "ZAI"\nmodel = "glm-5.3"\nreview_model = "glm-5.3"\n\n[model_providers.ZAI]\nname = "ZAI"\nbase_url = "https://z.ai"\n\n[agents]\nenabled = true\ndefault_subagent_model = "glm-5.3-flash"\n'
  it('remaps review_model and default_subagent_model that point at the old provider', () => {
    const parsed = TOML.parse(ok(ZAI_CFG, true)) as any
    expect(parsed.model_provider).toBe('llm-proxy')
    expect(parsed.model).toBe('auto/normal')
    expect(parsed.review_model).toBe('auto/high')
    expect(parsed.agents.default_subagent_model).toBe('auto/fast')
    expect(parsed.agents.enabled).toBe(true)
    expect(parsed.model_providers.ZAI.base_url).toBe('https://z.ai')
  })
  it('does not invent those keys when the user never set them', () => {
    const parsed = TOML.parse(ok('', true)) as any
    expect(parsed.review_model).toBeUndefined()
    expect(parsed.agents).toBeUndefined()
  })
  it('without makeDefault leaves the user provider and models alone', () => {
    const out = ok(ZAI_CFG, false)
    expect(codexDefaultProvider(out)).toBe('ZAI')
    expect((TOML.parse(out) as any).review_model).toBe('glm-5.3')
  })
  it('re-applying is byte-identical', () => {
    const once = ok(ZAI_CFG, true)
    expect(ok(once, true)).toBe(once)
  })
  it('codexDefaultProvider reads the top-level key', () => {
    expect(codexDefaultProvider(undefined)).toBeUndefined()
    expect(codexDefaultProvider('model = "x"\n')).toBeUndefined()
    expect(codexDefaultProvider(ok('', true))).toBe('llm-proxy')
  })
})
