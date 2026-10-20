import path from 'node:path'
import { z } from 'zod'
import { Err, Ok, type Result, type Tool } from './domain.js'

/** Filesystem port: the only I/O this module performs. */
export interface FsPort {
  read(file: string): Promise<string | undefined>
  writeAtomic(file: string, content: string, mode: number): Promise<void>
  remove(file: string): Promise<void>
  list(dir: string): Promise<readonly string[]>
}

const ManifestSchema = z.object({
  createdAt: z.string(),
  files: z.array(z.object({ target: z.string(), existed: z.boolean(), backupName: z.string() })),
})

export type BackupError =
  | { readonly kind: 'no_backup'; readonly tool: Tool }
  | { readonly kind: 'bad_manifest'; readonly snapshot: string }

const FILE_MODE = 0o600

export const backupRoot = (home: string): string => path.join(home, '.config', 'agent-helper-internal', 'backups')

const snapshotDir = (home: string, tool: Tool, snapshot: string): string => path.join(backupRoot(home), tool, snapshot)

/** Snapshot name safe for filenames and sortable chronologically. */
export const snapshotName = (now: Date): string => now.toISOString().replace(/[:.]/g, '-')

export type PlannedFile = Readonly<{ target: string; content: string }>

/** Saves every original file (or the fact it did not exist) in one snapshot, then writes the new contents. */
export async function writeWithBackup(
  fs: FsPort,
  args: Readonly<{ home: string; tool: Tool; files: readonly PlannedFile[]; now: Date }>,
): Promise<string> {
  const snapshot = snapshotName(args.now)
  const dir = snapshotDir(args.home, args.tool, snapshot)
  const entries: { target: string; existed: boolean; backupName: string }[] = []
  for (const [i, file] of args.files.entries()) {
    const original = await fs.read(file.target)
    const backupName = `${i}.bak`
    if (original !== undefined) await fs.writeAtomic(path.join(dir, backupName), original, FILE_MODE)
    entries.push({ target: file.target, existed: original !== undefined, backupName })
  }
  const manifest = { createdAt: args.now.toISOString(), files: entries }
  await fs.writeAtomic(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', FILE_MODE)
  for (const file of args.files) await fs.writeAtomic(file.target, file.content, FILE_MODE)
  return snapshot
}

/** Restores the latest snapshot (or the named one) and returns its name. */
export async function restoreBackup(
  fs: FsPort,
  args: Readonly<{ home: string; tool: Tool; snapshot?: string }>,
): Promise<Result<string, BackupError>> {
  const names = [...(await fs.list(path.join(backupRoot(args.home), args.tool)))].sort()
  const snapshot = args.snapshot ?? names[names.length - 1]
  if (snapshot === undefined || !names.includes(snapshot)) return Err({ kind: 'no_backup', tool: args.tool })
  const dir = snapshotDir(args.home, args.tool, snapshot)
  const raw = await fs.read(path.join(dir, 'manifest.json'))
  let json: unknown
  try {
    json = raw === undefined ? undefined : JSON.parse(raw)
  } catch {
    json = undefined
  }
  const manifest = ManifestSchema.safeParse(json)
  if (!manifest.success) return Err({ kind: 'bad_manifest', snapshot })
  // Read every original first so a corrupt snapshot fails before anything is touched.
  const originals: { target: string; content: string | undefined }[] = []
  for (const entry of manifest.data.files) {
    const content = entry.existed ? await fs.read(path.join(dir, entry.backupName)) : undefined
    if (entry.existed && content === undefined) return Err({ kind: 'bad_manifest', snapshot })
    originals.push({ target: entry.target, content })
  }
  for (const o of originals) {
    if (o.content === undefined) await fs.remove(o.target)
    else await fs.writeAtomic(o.target, o.content, FILE_MODE)
  }
  return Ok(snapshot)
}
