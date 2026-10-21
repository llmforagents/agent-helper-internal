import { describe, expect, it } from 'vitest'
import { applyShellRc, keyEnvContent, rcFileFor } from '../src/shell.js'

describe('shell helpers', () => {
  it('quotes the key so it is never interpreted by the shell', () => {
    expect(keyEnvContent("a'b$(x)")).toBe(`export LLM_PROXY_API_KEY='a'\\''b$(x)'\n`)
  })
  it('applyShellRc puts the block first, so later auto-start lines cannot hide it', () => {
    const rc = 'eval "$(zellij setup --generate-auto-start bash)"\nalias a=b\n'
    const out = applyShellRc(rc, '/e/env')
    expect(out.startsWith('# >>> agent-helper-internal >>>')).toBe(true)
    expect(out.indexOf('. \'/e/env\'')).toBeLessThan(out.indexOf('zellij'))
    expect(out.endsWith(rc)).toBe(true)
  })
  it('applyShellRc is idempotent, refreshes the path, and moves an old bottom block to the top', () => {
    const once = applyShellRc('alias a=b\n', '/e/env')
    expect(applyShellRc(once, '/e/env')).toBe(once)
    const moved = applyShellRc(once, '/other/env')
    expect(moved).toContain('/other/env')
    expect(moved).not.toContain('/e/env')
    expect(moved.match(/# >>> agent-helper-internal/g)).toHaveLength(1)
    const legacy = 'eval zellij\n\n# >>> agent-helper-internal >>>\n[ -f \'/e/env\' ] && . \'/e/env\'\n# <<< agent-helper-internal <<<\n'
    const fixed = applyShellRc(legacy, '/e/env')
    expect(fixed.startsWith('# >>> agent-helper-internal >>>')).toBe(true)
    expect(fixed.trimEnd().endsWith('eval zellij')).toBe(true)
    expect(fixed.match(/# >>> agent-helper-internal/g)).toHaveLength(1)
  })
  it('picks the rc by shell', () => {
    expect(rcFileFor('/h', '/bin/zsh')).toBe('/h/.zshrc')
    expect(rcFileFor('/h', '/bin/bash')).toBe('/h/.bashrc')
    expect(rcFileFor('/h', undefined)).toBe('/h/.bashrc')
  })
})
