import { describe, expect, it } from 'vitest'
import { run, type Deps } from '../src/app.js'
import { memFs } from './helpers.js'

const KEY = 'sk-test-' + 'x'.repeat(30)
const modelsBody = { data: [
  { id: 'auto/high', owned_by: 'a,b' }, { id: 'auto/normal', owned_by: 'c' }, { id: 'auto/fast', owned_by: 'd' },
] }

function setup(initial: Record<string, string> = {}, status = 200) {
  const fs = memFs(initial)
  const out: string[] = []
  const err: string[] = []
  const calls: string[] = []
  const deps: Deps = {
    fs, home: '/home/u', env: {}, now: () => new Date('2026-10-20T10:00:00Z'),
    out: (l) => out.push(l), err: (l) => err.push(l),
    fetch: async (url, init) => {
      calls.push(`${url} ${init.headers['authorization']}`)
      return new Response(JSON.stringify(modelsBody), { status })
    },
  }
  return { fs, out, err, calls, deps }
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
    const deps: Deps = { ...s.deps, env: { CLAUDE_CONFIG_DIR: '/c', CODEX_HOME: '/x' } }
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
})
