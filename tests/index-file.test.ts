import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EntryIndex, indexPathFor } from '../src/store/index-file.js'
import { entryId } from '../src/store/ids.js'

const DAY = 24 * 60 * 60 * 1000

async function withIndex() {
  const dir = await mkdtemp(join(tmpdir(), 'idx-'))
  const index = new EntryIndex(indexPathFor(dir))
  await index.load()
  return { dir, index, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

const docs = (memory: string, user = '') => ({ memory, user })

describe('EntryIndex.sync', () => {
  it('creates a record per entry with zero hits', async () => {
    const { index, cleanup } = await withIndex()
    try {
      const records = index.sync(docs('rule one\n§\nrule two'), new Date('2026-01-01T00:00:00Z'))

      expect(records).toHaveLength(2)
      expect(records[0]).toMatchObject({
        id: entryId('memory', 'rule one'),
        target: 'memory',
        chars: 'rule one'.length,
        hits: 0,
        firstSeenAt: '2026-01-01T00:00:00.000Z',
      })
      expect(records[0]?.lastHitAt).toBeUndefined()
    } finally {
      await cleanup()
    }
  })

  it('keeps hits and firstSeenAt across a sync', async () => {
    const { index, cleanup } = await withIndex()
    try {
      index.sync(docs('rule one'), new Date('2026-01-01T00:00:00Z'))
      index.recordHit(entryId('memory', 'rule one'), new Date('2026-01-05T00:00:00Z'))

      const [record] = index.sync(docs('rule one\n§\nrule two'), new Date('2026-02-01T00:00:00Z'))

      expect(record?.hits).toBe(1)
      expect(record?.firstSeenAt).toBe('2026-01-01T00:00:00.000Z')
      expect(record?.lastHitAt).toBe('2026-01-05T00:00:00.000Z')
    } finally {
      await cleanup()
    }
  })

  it('drops records for entries that left the document', async () => {
    const { index, cleanup } = await withIndex()
    try {
      index.sync(docs('rule one\n§\nrule two'))
      const remaining = index.sync(docs('rule one'))

      expect(remaining.map((r) => r.headline)).toEqual(['rule one'])
    } finally {
      await cleanup()
    }
  })

  it('treats an edited entry as a new entry', async () => {
    // The stats belong to the text, not the slot: the rule that was read is not the
    // rule that exists after an edit, so carrying hits over would flatter a rule
    // nobody has consulted.
    const { index, cleanup } = await withIndex()
    try {
      index.sync(docs('止损 2.96'))
      index.recordHit(entryId('memory', '止损 2.96'))

      const [record] = index.sync(docs('止损 3.02'))

      expect(record?.hits).toBe(0)
      expect(record?.headline).toBe('止损 3.02')
    } finally {
      await cleanup()
    }
  })

  it('ignores hits for unknown ids instead of inventing records', async () => {
    const { index, cleanup } = await withIndex()
    try {
      index.sync(docs('rule one'))
      index.recordHit('m-0000000000')

      expect(index.snapshot()).toHaveLength(1)
      expect(index.byId('m-0000000000')).toBeUndefined()
    } finally {
      await cleanup()
    }
  })
})

describe('EntryIndex persistence', () => {
  it('round-trips statistics through the sidecar', async () => {
    const { dir, index, cleanup } = await withIndex()
    try {
      index.sync(docs('rule one\n§\nrule two'))
      index.recordHit(entryId('memory', 'rule two'))
      await index.save()

      const reloaded = new EntryIndex(indexPathFor(dir))
      await reloaded.load()
      const [second] = reloaded.sync(docs('rule one\n§\nrule two')).slice(1)

      expect(second?.hits).toBe(1)
      // Written with the entry text in `headline`, so a human can read the file.
      expect(second?.headline).toBe('rule two')
    } finally {
      await cleanup()
    }
  })

  it('starts empty when the sidecar is corrupt rather than failing', async () => {
    // Statistics are a convenience; a truncated file must not take memory down. The
    // documents are the source of truth and the next sync rebuilds every id.
    const { dir, cleanup } = await withIndex()
    try {
      await writeFile(indexPathFor(dir), '{not json', 'utf8')
      const index = new EntryIndex(indexPathFor(dir))
      await index.load()

      expect(index.snapshot()).toEqual([])
      expect(index.sync(docs('rule one'))).toHaveLength(1)
    } finally {
      await cleanup()
    }
  })

  it('writes a versioned document', async () => {
    const { dir, index, cleanup } = await withIndex()
    try {
      index.sync(docs('rule one'))
      await index.save()
      const parsed = JSON.parse(await readFile(indexPathFor(dir), 'utf8')) as { version: number }

      expect(parsed.version).toBe(1)
    } finally {
      await cleanup()
    }
  })

  it('does not rewrite the file when nothing changed', async () => {
    const { dir, index, cleanup } = await withIndex()
    try {
      index.sync(docs('rule one'))
      await index.save()
      const before = await readFile(indexPathFor(dir), 'utf8')

      await index.save()

      expect(await readFile(indexPathFor(dir), 'utf8')).toBe(before)
    } finally {
      await cleanup()
    }
  })
})

describe('EntryIndex.cold', () => {
  const now = new Date('2026-03-01T00:00:00Z')

  it('lists entries that have gone unused, largest first', async () => {
    const { index, cleanup } = await withIndex()
    try {
      const longRule = 'long rule '.repeat(20).trim()
      const old = new Date(now.getTime() - 100 * DAY)
      index.sync(docs(`short\n§\n${longRule}\n§\nfresh`), old)
      // The third entry was added later, so it is not yet eligible.
      const freshId = entryId('memory', 'fresh')
      const sparse = index.snapshot().find((r) => r.id === freshId)
      if (sparse !== undefined) sparse.firstSeenAt = now.toISOString()

      const cold = index.cold({ afterDays: 45, minAgeDays: 14 }, now)

      // Largest first: the report answers "what should I cut", and the biggest cold
      // entry is the most compression per deletion.
      expect(cold.map((r) => r.chars)).toEqual([longRule.length, 'short'.length])
      expect(cold.map((r) => r.id)).toEqual([
        entryId('memory', longRule),
        entryId('memory', 'short'),
      ])
    } finally {
      await cleanup()
    }
  })

  it('excludes entries that were hit recently', async () => {
    const { index, cleanup } = await withIndex()
    try {
      const old = new Date(now.getTime() - 100 * DAY)
      index.sync(docs('used\n§\nunused'), old)
      index.recordHit(entryId('memory', 'used'), new Date(now.getTime() - 2 * DAY))

      expect(index.cold({ afterDays: 45, minAgeDays: 14 }, now).map((r) => r.headline)).toEqual([
        'unused',
      ])
    } finally {
      await cleanup()
    }
  })

  it('never reports an entry younger than minAgeDays', async () => {
    // A rule written yesterday has had one day of chances; reporting it as unused
    // says more about its age than about its value.
    const { index, cleanup } = await withIndex()
    try {
      index.sync(docs('yesterday'), new Date(now.getTime() - 1 * DAY))

      expect(index.cold({ afterDays: 45, minAgeDays: 14 }, now)).toEqual([])
    } finally {
      await cleanup()
    }
  })
})

describe('EntryIndex.hot', () => {
  it('returns only entries with hits, most used first', async () => {
    const { index, cleanup } = await withIndex()
    try {
      index.sync(docs('a\n§\nb\n§\nc'))
      index.recordHit(entryId('memory', 'b'))
      index.recordHit(entryId('memory', 'b'))
      index.recordHit(entryId('memory', 'c'))

      expect(index.hot(5).map((r) => [r.headline, r.hits])).toEqual([
        ['b', 2],
        ['c', 1],
      ])
    } finally {
      await cleanup()
    }
  })
})
