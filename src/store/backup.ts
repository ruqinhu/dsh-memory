import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const BACKED_UP = ['MEMORY.md', 'USER.md'] as const

/** Offset used to stamp backups by the operator's local day rather than UTC. */
const LOCAL_OFFSET_MS = 8 * 3_600_000

/**
 * `YYYYMMDD_HHMMSS` in +08:00.
 *
 * The local offset is applied explicitly: a Saturday 01:30 +08:00 run would
 * otherwise be stamped with the previous UTC day, which makes rotation order and
 * human reading both misleading.
 */
export function stamp(date: Date): string {
  const shifted = new Date(date.getTime() + LOCAL_OFFSET_MS)
  return shifted.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_')
}

/** Copy the memory documents into `backups/<stamp>/` and return that directory. */
export async function backupMemories(memoryDir: string, at: Date): Promise<string> {
  const dest = join(memoryDir, 'backups', stamp(at))
  await mkdir(dest, { recursive: true })
  for (const name of BACKED_UP) {
    try {
      await copyFile(join(memoryDir, name), join(dest, name))
    } catch (error) {
      // A missing document is normal on a fresh deployment; copy what exists.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
  return dest
}

/** Keep only the newest `keep` backup directories. */
export async function rotateBackups(root: string, keep: number): Promise<void> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const sorted = names.sort().reverse()
  for (const stale of sorted.slice(Math.max(0, keep))) {
    await rm(join(root, stale), { recursive: true, force: true })
  }
}
