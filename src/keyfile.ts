import path from 'node:path'

/**
 * 0600 file holding the raw API key. Codex runs `cat <this file>` to obtain the bearer token (provider `auth`
 * command), so the key does not depend on the environment of any process, including Codex's background server.
 */
export const keyFilePath = (home: string): string => path.join(home, '.config', 'agent-helper-internal', 'api-key')
