import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { backupMemories, rotateBackups, stamp } from '../src/store/backup.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'backup-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('stamp', () => {
  it('formats as YYYYMMDD_HHMMSS in +08:00', () => {
    expect(stamp(new Date('2026-10-27T01:30:00+08:00'))).toBe('20261027_013000')
  })

  it('uses the local day for a UTC-late timestamp', () => {
    // 2026-10-27T23:30Z is 2026-10-28 07:30 in +08:00.
    expect(stamp(new Date('2026-10-27T23:30:00Z'))).toBe('20261028_073000')
  })
})

describe('backupMemories', () => {
  it('copies both documents into a timestamped directory', async () => {
    await writeFile(join(dir, 'MEMORY.md'), 'm\n', 'utf8')
    await writeFile(join(dir, 'USER.md'), 'u\n', 'utf8')

    const dest = await backupMemories(dir, new Date('2026-10-27T01:30:00+08:00'))

    expect(dest).toContain('20261027_013000')
    expect((await readdir(dest)).sort()).toEqual(['MEMORY.md', 'USER.md'])
  })

  it('skips a missing document instead of failing', async () => {
    await writeFile(join(dir, 'MEMORY.md'), 'm\n', 'utf8')
    const dest = await backupMemories(dir, new Date('2026-10-27T01:30:00+08:00'))
    expect(await readdir(dest)).toEqual(['MEMORY.md'])
  })
})

describe('rotateBackups', () => {
  it('keeps only the newest N backups', async () => {
    const root = join(dir, 'backups')
    for (const name of ['20260101_000000', '20260102_000000', '20260103_000000']) {
      await mkdir(join(root, name), { recursive: true })
    }

    await rotateBackups(root, 2)

    expect((await readdir(root)).sort()).toEqual(['20260102_000000', '20260103_000000'])
  })

  it('keeps everything when under the limit', async () => {
    const root = join(dir, 'backups')
    await mkdir(join(root, '20260101_000000'), { recursive: true })

    await rotateBackups(root, 12)

    expect(await readdir(root)).toHaveLength(1)
  })

  it('does nothing when the backups directory is absent', async () => {
    await expect(rotateBackups(join(dir, 'nope'), 12)).resolves.toBeUndefined()
  })
})
