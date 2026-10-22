import { describe, expect, it } from 'vitest'
import { run, type Deps } from '../src/app.js'
import { memFs } from './helpers.js'

const KEY = 'sk-test-' + 'x'.repeat(30)
const modelsBody = { data: [
  { id: 'auto/high', owned_by: 'a,b' }, { id: 'auto/normal', owned_by: 'c' }, { id: 'auto/fast', owned_by: 'd' },
] }

function setup(initial: Record<string, string> = {}, status = 200, answers: string[] = [], interactive = false) {
  const fs = memFs(initial)
  const out: string[] = []
  const err: string[] = []
  const calls: string[] = []
  const asked: { question: string; hidden: boolean }[] = []
  const deps: Deps = {
    fs, home: '/home/u', env: { SHELL: '/bin/bash' }, now: () => new Date('2026-10-20T10:00:00Z'),
    interactive,
    prompt: async (question, opts) => { asked.push({ question, hidden: opts.hidden }); return answers.shift() ?? '' },
    out: (l) => out.push(l), err: (l) => err.push(l),
    fetch: async (url, init) => {
      calls.push(`${url} ${init.headers['authorization']}`)
      return new Response(JSON.stringify(modelsBody), { status })
    },
  }
  return { fs, out, err, calls, asked, deps }
}

describe('run', () => {
  it('apply all: verifies the key, writes both configs, never prints the full key', async () => {
    const s = setup()
    const code = await run(['apply', 'all', '--api-key', KEY], s.deps)
    expect(code).toBe(0)
    expect(s.calls[0]).toContain('https://llm-proxy-prod.fcorp.workers.dev/v1/models')
    expect(s.fs.files.get('/home/u/.claude/settings.json')).toContain('auto/high')
    expect(s.fs.files.get('/home/u/.codex/config.toml')).toContain('[model_providers.llm-proxy]')
    expect(s.fs.files.get('/home/u/.codex/llm-fast.config.toml')).toContain('auto/fast')
    expect(s.fs.files.get('/home/u/.codex/llm-high.config.toml')).toContain('auto/high')
    expect(s.out.join('\n')).not.toContain(KEY)
  })
  it('does not write anything when the key is rejected', async () => {
    const s = setup({}, 401)
    expect(await run(['apply', 'claude', '--api-key', KEY], s.deps)).toBe(1)
    expect(s.fs.files.size).toBe(0)
  })
  it('--dry-run writes nothing', async () => {
    const s = setup()
    expect(await run(['apply', 'all', '--api-key', KEY, '--dry-run'], s.deps)).toBe(0)
    expect(s.fs.files.size).toBe(0)
  })
  it('restore puts the original back, and removes files that did not exist', async () => {
    const original = '{"env":{"KEEP":"1"}}'
    const s = setup({ '/home/u/.claude/settings.json': original })
    await run(['apply', 'all', '--api-key', KEY], s.deps)
    expect(await run(['restore', 'claude'], s.deps)).toBe(0)
    expect(s.fs.files.get('/home/u/.claude/settings.json')).toBe(original)
    expect(await run(['restore', 'codex'], s.deps)).toBe(0)
    expect(s.fs.files.has('/home/u/.codex/config.toml')).toBe(false)
    expect(s.fs.files.has('/home/u/.codex/llm-high.config.toml')).toBe(false)
  })
  it('status reflects applied state', async () => {
    const s = setup()
    await run(['apply', 'all', '--api-key', KEY], s.deps)
    s.out.length = 0
    await run(['status', '--api-key', KEY], s.deps)
    expect(s.out).toEqual(['claude: configured', 'codex: configured'])
  })
  it('honours CLAUDE_CONFIG_DIR and CODEX_HOME', async () => {
    const s = setup()
    const deps: Deps = { ...s.deps, env: { CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x', SHELL: '/bin/bash' } }
    await run(['apply', 'all', '--api-key', KEY, '--no-verify'], deps)
    expect(s.fs.files.has('/c/settings.json')).toBe(true)
    expect(s.fs.files.has('/x/config.toml')).toBe(true)
    expect(s.fs.files.has('/x/llm-normal.config.toml')).toBe(true)
  })
  it('refuses to overwrite a profile file it did not write', async () => {
    const mine = 'model = "mine"\n'
    const s = setup({ '/home/u/.codex/llm-high.config.toml': mine })
    expect(await run(['apply', 'codex', '--api-key', KEY], s.deps)).toBe(1)
    expect(s.fs.files.get('/home/u/.codex/llm-high.config.toml')).toBe(mine)
    expect(s.fs.files.has('/home/u/.codex/config.toml')).toBe(false)
  })
  it('second apply is a no-op', async () => {
    const s = setup()
    await run(['apply', 'all', '--api-key', KEY], s.deps)
    s.out.length = 0
    await run(['apply', 'all', '--api-key', KEY], s.deps)
    expect(s.out.filter((l) => l.includes('already up to date'))).toHaveLength(2)
  })
  it('requires a key and a valid tool', async () => {
    const s = setup()
    expect(await run(['apply', 'claude'], s.deps)).toBe(2)
    expect(await run(['apply', 'nope', '--api-key', KEY], s.deps)).toBe(2)
    expect(await run([], s.deps)).toBe(2)
  })

  describe('interactive key', () => {
    it('asks for the key (hidden) when none is given and uses it', async () => {
      const s = setup({}, 200, [KEY], true)
      expect(await run(['apply', 'all'], s.deps)).toBe(0)
      expect(s.asked[0]).toEqual({ question: expect.stringContaining('API key'), hidden: true })
      expect(s.calls[0]).toContain(`Bearer ${KEY}`)
      expect(s.fs.files.get('/home/u/.claude/settings.json')).toContain(KEY)
      expect(s.out.join('\n') + s.err.join('\n')).not.toContain(KEY)
    })
    it('does not ask when the key comes from a flag or env', async () => {
      const s = setup({}, 200, [], true)
      await run(['apply', 'claude', '--api-key', KEY], s.deps)
      expect(s.asked).toHaveLength(0)
    })
    it('fails cleanly when not interactive and no key', async () => {
      const s = setup({}, 200, [KEY], false)
      expect(await run(['apply', 'claude'], s.deps)).toBe(2)
      expect(s.asked).toHaveLength(0)
    })
    it('rejects an empty answer', async () => {
      const s = setup({}, 200, [''], true)
      expect(await run(['apply', 'claude'], s.deps)).toBe(2)
      expect(s.fs.files.size).toBe(0)
    })
    it('status never prompts', async () => {
      const s = setup({}, 200, [KEY], true)
      expect(await run(['status'], s.deps)).toBe(0)
      expect(s.asked).toHaveLength(0)
    })
  })

  describe('doctor', () => {
    const responsesBody = { object: 'response', output: [] }
    function doctorSetup(opts: { shellKey?: string; status?: number; responses?: unknown } = {}) {
      const s = setup()
      const deps: Deps = {
        ...s.deps,
        env: { SHELL: '/bin/bash', ...(opts.shellKey !== undefined ? { LLM_PROXY_API_KEY: opts.shellKey } : {}) },
        fetch: async (url, init) => {
          if ((opts.status ?? 200) !== 200) return new Response('{}', { status: opts.status ?? 200 })
          if (url.endsWith('/v1/responses')) {
            expect(init.method).toBe('POST')
            return new Response(JSON.stringify(opts.responses ?? responsesBody), { status: 200 })
          }
          return new Response(JSON.stringify(modelsBody), { status: 200 })
        },
      }
      return { ...s, deps }
    }

    it('passes when configs exist, the key file matches and the gateway answers', async () => {
      const d = doctorSetup({ shellKey: KEY })
      await run(['apply', 'all', '--api-key', KEY, '--no-verify'], d.deps)
      d.out.length = 0
      expect(await run(['doctor', '--api-key', KEY], d.deps)).toBe(0)
      expect(d.out.every((l) => l.startsWith('[ok]'))).toBe(true)
    })
    it('flags a missing key file and says how to fix it', async () => {
      const d = doctorSetup()
      await run(['apply', 'claude', '--api-key', KEY, '--no-verify'], d.deps)
      d.out.length = 0
      expect(await run(['doctor', '--api-key', KEY], d.deps)).toBe(1)
      const line = d.out.find((l) => l.includes('key file')) ?? ''
      expect(line.startsWith('[FAIL]')).toBe(true)
      expect(line).toContain('apply codex')
    })
    it('reports an unconfigured tool with the command that fixes it', async () => {
      const d = doctorSetup({ shellKey: KEY })
      expect(await run(['doctor', '--api-key', KEY], d.deps)).toBe(1)
      expect(d.out.join('\n')).toContain('agent-helper-internal apply codex')
    })
    it('detects a gateway whose /v1/responses is not a Responses object', async () => {
      const d = doctorSetup({ shellKey: KEY, responses: { hello: 'world' } })
      await run(['apply', 'all', '--api-key', KEY, '--no-verify'], d.deps)
      d.out.length = 0
      expect(await run(['doctor', '--api-key', KEY], d.deps)).toBe(1)
      expect(d.out.find((l) => l.includes('/v1/responses'))).toContain('[FAIL]')
    })
    it('reports a rejected key', async () => {
      const d = doctorSetup({ shellKey: KEY, status: 401 })
      expect(await run(['doctor', '--api-key', KEY], d.deps)).toBe(1)
      expect(d.out.join('\n')).toContain('rejected the API key')
    })
  })

  describe('Codex default', () => {
    const CFG = '/home/u/.codex/config.toml'
    const ZAI = 'model_provider = "ZAI"\nmodel = "glm-5.3"\n\n[model_providers.ZAI]\nname = "ZAI"\nbase_url = "https://z.ai"\n'
    it('apply makes plain codex use the gateway by default, and restore brings ZAI back', async () => {
      const s = setup({ [CFG]: ZAI })
      expect(await run(['apply', 'codex', '--api-key', KEY], s.deps)).toBe(0)
      expect(s.fs.files.get(CFG)).toContain('model_provider = "llm-proxy"')
      expect(s.out.join('\n')).toContain('plain `codex` now uses auto/normal')
      expect(await run(['restore', 'codex'], s.deps)).toBe(0)
      expect(s.fs.files.get(CFG)).toBe(ZAI)
    })
    it('--no-default keeps the current provider but still adds the profiles', async () => {
      const s = setup({ [CFG]: ZAI })
      await run(['apply', 'codex', '--api-key', KEY, '--no-default'], s.deps)
      expect(s.fs.files.get(CFG)).toContain('model_provider = "ZAI"')
      expect(s.fs.files.has('/home/u/.codex/llm-high.config.toml')).toBe(true)
      expect(s.out.join('\n')).toContain('your default is unchanged')
    })
  })

  describe('Codex model catalog', () => {
    const CFG = '/home/u/.codex/config.toml'
    it("merges the tiers into the user's own catalog and restore brings it back", async () => {
      const catalog = JSON.stringify({ models: [{ slug: 'glm-5.3' }] })
      const s = setup({ [CFG]: 'model_catalog_json = "~/.codex/models.json"\n', '/home/u/.codex/models.json': catalog })
      expect(await run(['apply', 'codex', '--api-key', KEY], s.deps)).toBe(0)
      const slugs = (JSON.parse(s.fs.files.get('/home/u/.codex/models.json') ?? '{}') as { models: { slug: string }[] }).models.map((m) => m.slug)
      expect(slugs).toEqual(['auto/high', 'auto/normal', 'auto/fast', 'glm-5.3'])
      expect(await run(['restore', 'codex'], s.deps)).toBe(0)
      expect(s.fs.files.get('/home/u/.codex/models.json')).toBe(catalog)
    })
    it('creates and points to its own catalog when the user has none (default mode)', async () => {
      const s = setup()
      await run(['apply', 'codex', '--api-key', KEY], s.deps)
      expect(s.fs.files.get(CFG)).toContain('model_catalog_json = "/home/u/.codex/llm-proxy-models.json"')
      expect(s.fs.files.has('/home/u/.codex/llm-proxy-models.json')).toBe(true)
      await run(['restore', 'codex'], s.deps)
      expect(s.fs.files.has('/home/u/.codex/llm-proxy-models.json')).toBe(false)
    })
    it('--no-default without a user catalog does not create one', async () => {
      const s = setup()
      await run(['apply', 'codex', '--api-key', KEY, '--no-default'], s.deps)
      expect(s.fs.files.has('/home/u/.codex/llm-proxy-models.json')).toBe(false)
    })
    it('refuses to touch a user catalog it cannot parse', async () => {
      const s = setup({ [CFG]: 'model_catalog_json = "/m.json"\n', '/m.json': 'garbage' })
      expect(await run(['apply', 'codex', '--api-key', KEY], s.deps)).toBe(1)
      expect(s.fs.files.get('/m.json')).toBe('garbage')
    })
  })

  describe('Codex key file', () => {
    const KEYFILE = '/home/u/.config/agent-helper-internal/api-key'
    it('stores the key in a file that the provider auth command reads, and never in config.toml', async () => {
      const s = setup()
      await run(['apply', 'codex', '--api-key', KEY], s.deps)
      expect(s.fs.files.get(KEYFILE)).toBe(KEY)
      const config = s.fs.files.get('/home/u/.codex/config.toml') ?? ''
      expect(config).toContain(`args = ["${KEYFILE}"]`)
      expect(config).not.toContain(KEY)
      expect(config).not.toContain('env_key')
    })
    it('does not ask about shell setup', async () => {
      const s = setup({}, 200, [KEY], true)
      await run(['apply', 'all'], s.deps)
      expect(s.asked).toHaveLength(1)
    })
    it('restore removes the key file', async () => {
      const s = setup()
      await run(['apply', 'codex', '--api-key', KEY], s.deps)
      await run(['restore', 'codex'], s.deps)
      expect(s.fs.files.has(KEYFILE)).toBe(false)
    })
  })
})
