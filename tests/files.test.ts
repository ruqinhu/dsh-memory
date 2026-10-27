import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MemoryFiles } from '../src/store/files.js'

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'memfiles-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe('MemoryFiles', () => {
  it('bootstraps empty documents in a new directory', async () => {
    const files = new MemoryFiles(dir)
    await files.load()
    expect(files.read('memory')).toBe('')
    expect(files.read('user')).toBe('')
  })

  it('reads existing documents on load', async () => {
    const seed = new MemoryFiles(dir)
    await seed.load()
    await seed.write('memory', 'rule one\n§\nrule two')

    const files = new MemoryFiles(dir)
    await files.load()
    expect(files.read('memory')).toBe('rule one\n§\nrule two')
  })

  it('serves reads synchronously from cache after a write', async () => {
    const files = new MemoryFiles(dir)
    await files.load()
    await files.write('user', 'profile line')
    expect(files.read('user')).toBe('profile line')
  })

  it('persists to disk with exactly one trailing newline', async () => {
    const files = new MemoryFiles(dir)
    await files.load()
    await files.write('memory', 'abc')
    expect(await readFile(join(dir, 'MEMORY.md'), 'utf8')).toBe('abc\n')
  })

  it('strips trailing newlines on load so repeated writes do not accumulate them', async () => {
    await writeFile(join(dir, 'MEMORY.md'), 'abc\n\n\n', 'utf8')
    const files = new MemoryFiles(dir)
    await files.load()
    expect(files.read('memory')).toBe('abc')
  })

  it('keeps the two documents independent', async () => {
    const files = new MemoryFiles(dir)
    await files.load()
    await files.write('memory', 'm')
    await files.write('user', 'u')
    expect(files.read('memory')).toBe('m')
    expect(files.read('user')).toBe('u')
  })

  it('exposes the directory and per-target paths', async () => {
    const files = new MemoryFiles(dir)
    await files.load()
    expect(files.directory()).toBe(dir)
    expect(files.path('memory')).toBe(join(dir, 'MEMORY.md'))
    expect(files.path('user')).toBe(join(dir, 'USER.md'))
  })

  it('does not update the cache when the write fails', async () => {
    // Persist-before-cache: if the cache were updated first, a failed write would
    // leave reads returning text that is not on disk, and a later cap check would
    // pass against content that vanished on restart.
    const files = new MemoryFiles(dir)
    await files.load()
    await files.write('memory', 'original')

    const blocked = new MemoryFiles(join(dir, 'MEMORY.md', 'nested'))
    await expect(blocked.load()).rejects.toThrow()
    try {
      await blocked.write('memory', 'never persisted')
      expect.unreachable()
    } catch {
      expect(blocked.read('memory')).not.toBe('never persisted')
    }
  })
})
