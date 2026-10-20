import { describe, expect, it } from 'vitest'
import { applyShellRc, keyEnvContent, rcFileFor } from '../src/shell.js'

describe('shell helpers', () => {
  it('quotes the key so it is never interpreted by the shell', () => {
    expect(keyEnvContent("a'b$(x)")).toBe(`export LLM_PROXY_API_KEY='a'\\''b$(x)'\n`)
  })
  it('applyShellRc is idempotent and refreshes the block in place', () => {
    const once = applyShellRc('alias a=b\n', '/e/env')
    expect(applyShellRc(once, '/e/env')).toBe(once)
    const moved = applyShellRc(once, '/other/env')
    expect(moved).toContain('/other/env')
    expect(moved).not.toContain('/e/env')
    expect(moved.startsWith('alias a=b')).toBe(true)
  })
  it('picks the rc by shell', () => {
    expect(rcFileFor('/h', '/bin/zsh')).toBe('/h/.zshrc')
    expect(rcFileFor('/h', '/bin/bash')).toBe('/h/.bashrc')
    expect(rcFileFor('/h', undefined)).toBe('/h/.bashrc')
  })
})
