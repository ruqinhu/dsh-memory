import { describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { MemoryFiles } from '../src/store/files.js'
import { EntryIndex, indexPathFor } from '../src/store/index-file.js'
import { entryId } from '../src/store/ids.js'
import { registerTools } from '../src/tools.js'

/** What a tool body returns; the registry would validate it against the schema. */
type ToolValue = Record<string, unknown>

async function harness(seed: { memory?: string; user?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'tools-'))
  const files = new MemoryFiles(dir)
  await files.load()
  if (seed.memory !== undefined) await files.write('memory', seed.memory)
  if (seed.user !== undefined) await files.write('user', seed.user)

  const index = new EntryIndex(indexPathFor(dir))
  await index.load()
  index.sync({ memory: files.read('memory'), user: files.read('user') })

  const tools = new Map<string, { execute: (args: unknown, ctx: unknown) => Promise<ToolValue> }>()
  const ctx = {
    tools: {
      register: (definition: { name: string }) => {
        tools.set(definition.name, definition as never)
      },
    },
  } as unknown as Context

  registerTools(ctx, {
    files,
    caps: { memory: 2200, user: 1375 },
    backupKeep: 3,
    index,
    stale: { afterDays: 45, minAgeDays: 14 },
  })

  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolValue> => {
    const tool = tools.get(name)
    if (tool === undefined) throw new Error(`tool ${name} not registered`)
    return tool.execute(args, {})
  }

  return {
    dir,
    files,
    index,
    tools,
    call,
    cleanup: () => rm(dir, { recursive: true, force: true }),
  }
}

describe('memory_get', () => {
  it('reads one entry by id and counts the hit', async () => {
    const { call, index, cleanup } = await harness({ memory: '止损 2.96\n§\n走弱日不追高' })
    try {
      const id = entryId('memory', '走弱日不追高')
      const result = await call('memory_get', { id })

      expect(result).toMatchObject({ found: true, id, target: 'memory', entry: '走弱日不追高' })
      expect(result.hits).toBe(1)
      expect(index.byId(id)?.hits).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('finds a user entry through its prefix', async () => {
    const { call, cleanup } = await harness({ user: '偏好简洁' })
    try {
      const result = await call('memory_get', { id: entryId('user', '偏好简洁') })

      expect(result).toMatchObject({ found: true, target: 'user', entry: '偏好简洁' })
    } finally {
      await cleanup()
    }
  })

  it('explains a miss instead of just denying it', async () => {
    // A stale index is the normal miss. "not found" alone invites a retry loop; the
    // message has to say what to do instead.
    const { call, cleanup } = await harness({ memory: '止损 2.96' })
    try {
      const result = await call('memory_get', { id: 'm-0000000000' })

      expect(result.found).toBe(false)
      expect(String(result.error)).toContain('memory_search')
    } finally {
      await cleanup()
    }
  })

  it('rejects a malformed id without scanning the documents', async () => {
    const { call, cleanup } = await harness({ memory: '止损 2.96' })
    try {
      const result = await call('memory_get', { id: '止损 2.96' })

      expect(result.found).toBe(false)
      expect(String(result.error)).toContain('not an entry id')
    } finally {
      await cleanup()
    }
  })

  it('resolves an entry that was appended in the same session', async () => {
    const { call, cleanup } = await harness({ memory: 'rule one' })
    try {
      await call('memory_append', { target: 'memory', entry: 'rule two' })

      const result = await call('memory_get', { id: entryId('memory', 'rule two') })

      expect(result).toMatchObject({ found: true, entry: 'rule two' })
    } finally {
      await cleanup()
    }
  })
})

describe('memory_search', () => {
  it('returns an id with every match and counts only the returned ones', async () => {
    const { call, index, cleanup } = await harness({
      memory: '止损 2.96\n§\n止损口径\n§\n无关条目',
    })
    try {
      const result = (await call('memory_search', { query: '止损', limit: 1 })) as {
        matches: { id: string; entry: string }[]
        total: number
      }

      expect(result.total).toBe(2)
      expect(result.matches).toHaveLength(1)
      expect(result.matches[0]?.id).toBe(entryId('memory', result.matches[0]!.entry))
      // Only the returned match was used; the other one was scored but not shown.
      expect(index.snapshot().filter((r) => r.hits > 0)).toHaveLength(1)
    } finally {
      await cleanup()
    }
  })
})

describe('memory_maintenance', () => {
  it('reports cold entries with a concrete hint', async () => {
    const { call, index, cleanup } = await harness({ memory: 'old rule\n§\nfresh rule' })
    try {
      const oldId = entryId('memory', 'old rule')
      const stale = index.byId(oldId)
      if (stale !== undefined) stale.firstSeenAt = new Date(Date.now() - 120 * 86_400_000).toISOString()
      await index.save()

      const result = (await call('memory_maintenance', { backup: false })) as {
        cold: { id: string }[]
        hint: string
      }

      expect(result.cold.map((entry) => entry.id)).toContain(oldId)
      expect(result.cold.map((entry) => entry.id)).not.toContain(entryId('memory', 'fresh rule'))
      expect(result.hint).toContain('unused')
    } finally {
      await cleanup()
    }
  })

  it('returns empty statistics rather than omitting the fields', async () => {
    // The output schema requires both arrays; omitting them would fail validation on
    // exactly the quiet day the maintenance job is most likely to run.
    const { call, cleanup } = await harness({ memory: 'recent rule' })
    try {
      const result = await call('memory_maintenance', { backup: false })

      expect(result.cold).toEqual([])
      expect(result.hot).toEqual([])
      expect(result.ok).toBe(true)
    } finally {
      await cleanup()
    }
  })
})
