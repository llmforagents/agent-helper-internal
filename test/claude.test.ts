import { describe, expect, it } from 'vitest'
import { applyClaudeSettings, detectClaude } from '../src/claude.js'
import { testConfig } from './helpers.js'

const cfg = testConfig()

describe('applyClaudeSettings', () => {
  it('maps opus/sonnet/haiku to auto/high|normal|fast and points at the gateway root', () => {
    const r = applyClaudeSettings('', cfg)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const env = JSON.parse(r.value).env
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gw.example')
    expect(env.ANTHROPIC_DEFAULT_OPUS_MODEL).toBe('auto/high')
    expect(env.ANTHROPIC_DEFAULT_SONNET_MODEL).toBe('auto/normal')
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('auto/fast')
    expect(env.ANTHROPIC_MODEL).toBe('auto/normal')
  })
  it('preserves comments, hooks and unrelated env keys', () => {
    const src = '{\n  // my note\n  "env": { "MAX_THINKING_TOKENS": "31999" },\n  "hooks": { "a": 1 }\n}\n'
    const r = applyClaudeSettings(src, cfg)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toContain('// my note')
    const parsed = JSON.parse(r.value.replace('// my note', ''))
    expect(parsed.env.MAX_THINKING_TOKENS).toBe('31999')
    expect(parsed.hooks).toEqual({ a: 1 })
  })
  it('removes the retired ANTHROPIC_SMALL_FAST_MODEL', () => {
    const r = applyClaudeSettings('{"env":{"ANTHROPIC_SMALL_FAST_MODEL":"x"}}', cfg)
    expect(r.ok && JSON.parse(r.value).env.ANTHROPIC_SMALL_FAST_MODEL).toBeUndefined()
  })
  it('is idempotent', () => {
    const once = applyClaudeSettings('', cfg)
    if (!once.ok) throw new Error('unexpected')
    const twice = applyClaudeSettings(once.value, cfg)
    expect(twice.ok && twice.value).toBe(once.value)
  })
  it('rejects unparseable JSON instead of overwriting it', () => {
    const r = applyClaudeSettings('{ "env": ', cfg)
    expect(r.ok).toBe(false)
  })
})

describe('detectClaude', () => {
  it('reports each state', () => {
    expect(detectClaude(undefined, cfg)).toEqual({ ok: true, value: { state: 'not_configured' } })
    const applied = applyClaudeSettings('', cfg)
    if (!applied.ok) throw new Error('unexpected')
    expect(detectClaude(applied.value, cfg)).toEqual({ ok: true, value: { state: 'configured' } })
    const foreign = detectClaude('{"env":{"ANTHROPIC_BASE_URL":"https://other"}}', cfg)
    expect(foreign.ok && foreign.value.state).toBe('foreign')
    const partial = detectClaude('{"env":{"ANTHROPIC_BASE_URL":"https://gw.example"}}', cfg)
    expect(partial.ok && partial.value.state).toBe('partial')
  })
})
