import type { FsPort } from '../src/backup.js'
import { ApiKey, BaseUrl, type GatewayConfig } from '../src/domain.js'

export function memFs(initial: Readonly<Record<string, string>> = {}): FsPort & { files: Map<string, string> } {
  const files = new Map(Object.entries(initial))
  return {
    files,
    read: async (f) => files.get(f),
    writeAtomic: async (f, c) => { files.set(f, c) },
    remove: async (f) => { files.delete(f) },
    list: async (dir) => {
      const prefix = dir.endsWith('/') ? dir : `${dir}/`
      return [...new Set([...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split('/')[0] ?? ''))]
    },
  }
}

export function testConfig(): GatewayConfig {
  const base = BaseUrl('https://gw.example/')
  const key = ApiKey('k'.repeat(32))
  if (!base.ok || !key.ok) throw new Error('bad fixture')
  return { baseUrl: base.value, apiKey: key.value }
}
