import path from 'node:path'
import { API_KEY_ENV_VAR } from './domain.js'

const BEGIN = '# >>> agent-helper-internal >>>'
const END = '# <<< agent-helper-internal <<<'

/** 0600 file that exports the key; sourced from the shell rc so Codex (which reads the key from env) finds it. */
export const keyEnvFile = (home: string): string => path.join(home, '.config', 'agent-helper-internal', 'env')

export function rcFileFor(home: string, shell: string | undefined): string {
  return path.join(home, shell?.endsWith('zsh') === true ? '.zshrc' : '.bashrc')
}

/** Single-quote for POSIX shells so the key is never interpreted. */
const shQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

export const keyEnvContent = (apiKey: string): string => `export ${API_KEY_ENV_VAR}=${shQuote(apiKey)}\n`

/** Pure: adds (or refreshes) the managed block that sources the env file. Idempotent. */
export function applyShellRc(text: string, envFile: string): string {
  const block = `${BEGIN}\n[ -f ${shQuote(envFile)} ] && . ${shQuote(envFile)}\n${END}`
  const start = text.indexOf(BEGIN)
  const end = start === -1 ? -1 : text.indexOf(END, start)
  if (start !== -1 && end !== -1) return text.slice(0, start) + block + text.slice(end + END.length)
  const body = text.trimEnd()
  return `${body}${body === '' ? '' : '\n\n'}${block}\n`
}
