import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { loadEnv, run, type Deps } from './app.js'
import type { FsPort } from './backup.js'

function isNotFound(e: unknown): boolean {
  return typeof e === 'object' && e !== null && 'code' in e && e.code === 'ENOENT'
}

const nodeFs: FsPort = {
  async read(file) {
    try {
      return await readFile(file, 'utf8')
    } catch (e) {
      if (isNotFound(e)) return undefined
      throw e
    }
  },
  async writeAtomic(file, content, mode) {
    await mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await writeFile(tmp, content, { mode })
    await rename(tmp, file)
  },
  async remove(file) {
    await rm(file, { force: true })
  },
  async list(dir) {
    try {
      return await readdir(dir)
    } catch (e) {
      if (isNotFound(e)) return []
      throw e
    }
  },
}

const deps: Deps = {
  fs: nodeFs,
  fetch: (url, init) => fetch(url, init),
  env: loadEnv(process.env),
  home: os.homedir(),
  now: () => new Date(),
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
}

process.exitCode = await run(process.argv.slice(2), deps)
