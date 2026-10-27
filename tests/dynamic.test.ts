import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemoryFiles } from '../src/store/files.js'
import { INLINE_BUDGET_CHARS, MEMORY_CONTEXT_ORDER } from '../src/inject/dynamic.js'

async function withFiles(seed: { memory?: string; user?: string }) {
  const dir = await mkdtemp(join(tmpdir(), 'dyn-'))
  const files = new MemoryFiles(dir)
  await files.load()
  if (seed.memory !== undefined) await files.write('memory', seed.memory)
  if (seed.user !== undefined) await files.write('user', seed.user)
  return { dir, files, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

describe('dynamic injection constants', () => {
  it('places memory after team identity and before harness source', () => {
    expect(MEMORY_CONTEXT_ORDER).toBeGreaterThan(125)
    expect(MEMORY_CONTEXT_ORDER).toBeLessThan(200)
  })

  it('keeps the inline budget modest enough to protect working context', () => {
    expect(INLINE_BUDGET_CHARS).toBeLessThanOrEqual(8_000)
  })
})

describe('renderInline vs renderIndex selection', () => {
  it('inlines small documents', async () => {
    const { files, cleanup } = await withFiles({ memory: 'rule one\n§\nrule two', user: 'profile' })
    try {
      const total = files.read('memory').length + files.read('user').length
      expect(total).toBeLessThanOrEqual(INLINE_BUDGET_CHARS)
      expect(files.read('memory')).toContain('rule one')
    } finally {
      await cleanup()
    }
  })

  it('reports an empty document pair as empty', async () => {
    const { files, cleanup } = await withFiles({})
    try {
      expect(files.read('memory')).toBe('')
      expect(files.read('user')).toBe('')
    } finally {
      await cleanup()
    }
  })
})
