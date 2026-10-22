import TOML from '@iarna/toml'
import { describe, expect, it } from 'vitest'
import { applyCodexConfig, canWriteProfile, catalogEntry, codexDefaultProvider, declaredCatalogPath, detectCodex, mergeCatalog, profileContent, profilePath } from '../src/codex.js'
import { testConfig } from './helpers.js'

const cfg = testConfig()
const KEYFILE = '/h/.config/agent-helper-internal/api-key'
const USER = 'model_provider = "ZAI"\nmodel = "glm"\n# keep me\n\n[model_providers.ZAI]\nname = "ZAI"\nbase_url = "https://z.ai"\n'

function ok(text: string, makeDefault = false): string {
  const r = applyCodexConfig(text, cfg, { makeDefault, keyFile: KEYFILE })
  if (!r.ok) throw new Error(`${r.error.kind}: ${r.error.detail}`)
  return r.value
}

describe('applyCodexConfig', () => {
  it('adds the provider with base_url ending in /v1 and the responses wire API', () => {
    const parsed = TOML.parse(ok(USER)) as any
    expect(parsed.model_providers['llm-proxy']).toMatchObject({
      base_url: 'https://gw.example/v1', wire_api: 'responses', requires_openai_auth: false,
    })
  })
  it('gets the key from a command reading the key file, never from env_key or an inline token', () => {
    const out = ok(USER)
    const provider = (TOML.parse(out) as any).model_providers['llm-proxy']
    expect(provider.auth).toEqual({ command: 'cat', args: [KEYFILE] })
    expect(provider.env_key).toBeUndefined()
    expect(provider.experimental_bearer_token).toBeUndefined()
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
    expect(applyCodexConfig('[model_providers.llm-proxy]\nname="x"\n', cfg, { makeDefault: false, keyFile: KEYFILE }).ok).toBe(false)
  })
  it('rejects invalid TOML', () => {
    expect(applyCodexConfig('model = ', cfg, { makeDefault: false, keyFile: KEYFILE }).ok).toBe(false)
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
  it('flags an older env_key-style provider as partial so doctor tells the user to re-apply', () => {
    const legacy = 'model_provider = "llm-proxy"\n# >>> agent-helper-internal (managed, do not edit) >>>\n[model_providers.llm-proxy]\nbase_url = "https://gw.example/v1"\nenv_key = "LLM_PROXY_API_KEY"\n# <<< agent-helper-internal <<<\n'
    const r = detectCodex({ config: legacy, profiles }, cfg)
    expect(r.ok && r.value.state).toBe('partial')
  })
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

describe('model catalog', () => {
  const USER_CATALOG = JSON.stringify({ models: [{ slug: 'glm-5.3', display_name: 'glm-5.3', priority: 0 }, { slug: 'glm-5.3-flash', priority: 1 }] })
  const slugs = (text: string): string[] => (JSON.parse(text) as { models: { slug: string }[] }).models.map((m) => m.slug)

  it('adds the three tiers and keeps the user entries untouched', () => {
    const r = mergeCatalog(USER_CATALOG)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(slugs(r.value)).toEqual(['auto/high', 'auto/normal', 'auto/fast', 'glm-5.3', 'glm-5.3-flash'])
    expect((JSON.parse(r.value) as { models: { slug: string; priority: number }[] }).models.find((m) => m.slug === 'glm-5.3')?.priority).toBe(0)
  })
  it('creates a catalog from nothing and is idempotent', () => {
    const once = mergeCatalog(undefined)
    if (!once.ok) throw new Error('unexpected')
    expect(slugs(once.value)).toHaveLength(3)
    const twice = mergeCatalog(once.value)
    expect(twice.ok && twice.value).toBe(once.value)
  })
  it('rejects a catalog that is not {"models": [...]} instead of overwriting it', () => {
    expect(mergeCatalog('{"nope":1}').ok).toBe(false)
    expect(mergeCatalog('not json').ok).toBe(false)
  })
  it('omits apply_patch_tool_type: Codex rejects any value but "freeform", and freeform cannot cross the gateway', () => {
    for (const tier of ['high', 'normal', 'fast'] as const) {
      expect('apply_patch_tool_type' in catalogEntry(tier)).toBe(false)
      expect(catalogEntry(tier)['visibility']).toBe('list')
    }
  })
  it('resolves the declared catalog path (~, absolute, relative) and ignores a missing one', () => {
    expect(declaredCatalogPath('model_catalog_json = "~/.codex/models.json"\n', '/c', '/h')).toBe('/h/.codex/models.json')
    expect(declaredCatalogPath('model_catalog_json = "/abs/m.json"\n', '/c', '/h')).toBe('/abs/m.json')
    expect(declaredCatalogPath('model_catalog_json = "m.json"\n', '/c', '/h')).toBe('/c/m.json')
    expect(declaredCatalogPath('model = "x"\n', '/c', '/h')).toBeUndefined()
  })
  it('applyCodexConfig sets model_catalog_json only when asked', () => {
    const withIt = applyCodexConfig('', cfg, { makeDefault: true, catalogPath: '/c/llm-proxy-models.json', keyFile: KEYFILE })
    expect(withIt.ok && (TOML.parse(withIt.value) as any).model_catalog_json).toBe('/c/llm-proxy-models.json')
    const without = applyCodexConfig('', cfg, { makeDefault: true, keyFile: KEYFILE })
    expect(without.ok && (TOML.parse(without.value) as any).model_catalog_json).toBeUndefined()
  })
})
