import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { MemoryTarget } from './caps.js'
import { entryId } from './ids.js'
import { splitEntries } from './parse.js'

/**
 * Per-entry usage statistics, kept beside the documents as a sidecar.
 *
 * The memory documents say what the rules are; they cannot say which of them earn
 * their characters. That question is the whole difficulty of a compression pass —
 * the cap forces something out, and without evidence the choice defaults to
 * "whichever rule I happen to reread first", which is how a still-relevant rule
 * gets deleted and a dead one survives for another year.
 *
 * So every recall, search, and explicit read records a hit, and the maintenance
 * report can then name the entries that have not matched anything in weeks. The
 * evidence is a lower bound: an entry that is injected inline on every request is
 * being used without ever being "hit", so cold entries are candidates for review,
 * never for automatic deletion.
 */
export interface EntryRecord {
  id: string
  target: MemoryTarget
  chars: number
  /** First line, clipped: what the index shows and what a human scans in a report. */
  headline: string
  firstSeenAt: string
  lastHitAt?: string
  hits: number
}

interface IndexData {
  version: 1
  entries: EntryRecord[]
}

/** Sidecar filename. Dot-prefixed so it never reads as one of the documents. */
export const INDEX_FILE = '.entry-index.json'

const HEADLINE_CHARS = 80

function headlineOf(entry: string): string {
  const firstLine = entry.split('\n')[0] ?? entry
  return firstLine.length > HEADLINE_CHARS ? `${firstLine.slice(0, HEADLINE_CHARS)}…` : firstLine
}

const TARGETS: readonly MemoryTarget[] = ['memory', 'user']

export interface Documents {
  memory: string
  user: string
}

export interface ColdOptions {
  /** An entry with no hit for this long is cold. */
  afterDays: number
  /**
   * Never report an entry younger than this many days.
   *
   * A rule written yesterday has had one day of chances; calling it unused says
   * more about when it was written than about whether it matters, and a report
   * full of fresh entries trains the reader to ignore the report.
   */
  minAgeDays: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Read-modify-write store for {@link EntryRecord}s, aligned to the documents.
 *
 * Deliberately not a cache of the documents themselves: `sync` takes their
 * current text and reconciles, so the sidecar can never disagree with
 * `MEMORY.md` — an id that is not in the text is dropped on the next sync, and a
 * new entry appears with zero hits.
 */
export class EntryIndex {
  private records = new Map<string, EntryRecord>()
  private dirty = false
  private lastSavedAt = 0

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<IndexData>
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return
      for (const record of parsed.entries) {
        if (!isRecord(record)) continue
        this.records.set(record.id, record)
      }
    } catch {
      // A missing sidecar is the normal first run. A corrupt one is worse than
      // useless — it would resurrect statistics for entries that no longer exist —
      // but it is still not worth failing the plugin over: the documents are the
      // source of truth and the next sync rebuilds every id from them.
      this.records.clear()
    }
  }

  /** True once a caller has changed statistics that are not yet on disk. */
  get hasPendingWrites(): boolean {
    return this.dirty
  }

  /**
   * Align the records with the current documents and return the result.
   *
   * Removal is implicit: the map is rebuilt from what the documents contain now,
   * so an entry that was deleted loses its statistics with it. An edited entry
   * hashes differently and therefore starts at zero hits, which is the honest
   * answer — the rule that was read before is not the rule that exists now.
   */
  sync(documents: Documents, now: Date = new Date()): EntryRecord[] {
    const next = new Map<string, EntryRecord>()

    for (const target of TARGETS) {
      for (const entry of splitEntries(documents[target])) {
        const id = entryId(target, entry)
        const previous = this.records.get(id)
        next.set(id, {
          id,
          target,
          chars: entry.length,
          headline: headlineOf(entry),
          firstSeenAt: previous?.firstSeenAt ?? now.toISOString(),
          ...(previous?.lastHitAt === undefined ? {} : { lastHitAt: previous.lastHitAt }),
          hits: previous?.hits ?? 0,
        })
      }
    }

    if (!sameRecords(this.records, next)) this.dirty = true
    this.records = next
    return this.snapshot()
  }

  /**
   * Count one use of an entry.
   *
   * Unknown ids are ignored rather than created: a hit for an entry that is no
   * longer in the document is a stale reference from a previous turn, and
   * inventing a record for it would make the next `cold` report list a ghost.
   */
  recordHit(id: string, now: Date = new Date()): void {
    const record = this.records.get(id)
    if (record === undefined) return
    record.hits += 1
    record.lastHitAt = now.toISOString()
    this.dirty = true
  }

  /**
   * Entries that have not been used recently, largest first.
   *
   * Largest first because the report exists to answer "what should I cut", and the
   * biggest cold entry is the most compression per deletion.
   */
  cold(options: ColdOptions, now: Date = new Date()): EntryRecord[] {
    const afterMs = options.afterDays * DAY_MS
    const minAgeMs = options.minAgeDays * DAY_MS
    const nowMs = now.getTime()

    const out: EntryRecord[] = []
    for (const record of this.records.values()) {
      const firstSeen = Date.parse(record.firstSeenAt)
      const lastUsed = record.lastHitAt === undefined ? firstSeen : Date.parse(record.lastHitAt)
      if (!Number.isFinite(firstSeen) || !Number.isFinite(lastUsed)) continue
      if (nowMs - lastUsed < afterMs) continue
      if (nowMs - firstSeen < minAgeMs) continue
      out.push(record)
    }
    return out.sort((a, b) => b.chars - a.chars)
  }

  /** Most-used entries, for the other half of the maintenance report. */
  hot(limit: number): EntryRecord[] {
    return [...this.records.values()]
      .filter((record) => record.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, limit)
  }

  byId(id: string): EntryRecord | undefined {
    return this.records.get(id)
  }

  snapshot(): EntryRecord[] {
    return [...this.records.values()]
  }

  /**
   * Persist the sidecar.
   *
   * Write-then-rename so a kill mid-write cannot leave a truncated file: `load`
   * treats malformed JSON as "start over", so a partial write would silently
   * reset every statistic. Failures are the caller's to log — statistics are a
   * convenience, never a reason to fail a memory write that already landed.
   */
  async save(): Promise<void> {
    if (!this.dirty) return
    const data: IndexData = { version: 1, entries: this.snapshot() }
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.tmp`
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, this.path)
    this.dirty = false
    this.lastSavedAt = Date.now()
  }

  /**
   * Persist only if something changed and the last write is older than `minIntervalMs`.
   *
   * Automatic recall records a hit on every turn it fires. Saving on each of those
   * would rewrite the sidecar every turn for a few counter increments; never saving
   * would make every auto-recalled entry look cold at the next maintenance pass.
   * A minute of coalescing keeps both of those from happening.
   */
  async saveIfIdleSince(minIntervalMs: number, now: number = Date.now()): Promise<void> {
    if (!this.dirty) return
    if (now - this.lastSavedAt < minIntervalMs) return
    await this.save()
  }
}

function isRecord(value: unknown): value is EntryRecord {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<EntryRecord>
  return (
    typeof candidate.id === 'string' &&
    (candidate.target === 'memory' || candidate.target === 'user') &&
    typeof candidate.chars === 'number' &&
    typeof candidate.headline === 'string' &&
    typeof candidate.firstSeenAt === 'string' &&
    typeof candidate.hits === 'number'
  )
}

/**
 * Whether two record sets differ in anything a reader would see.
 *
 * Hits and timestamps are compared too: a sync that only picks up a hit still
 * has to be persisted, or the counter would reset on restart.
 */
function sameRecords(before: Map<string, EntryRecord>, after: Map<string, EntryRecord>): boolean {
  if (before.size !== after.size) return false
  for (const [id, record] of after) {
    const previous = before.get(id)
    if (previous === undefined) return false
    if (
      previous.chars !== record.chars ||
      previous.headline !== record.headline ||
      previous.hits !== record.hits ||
      previous.firstSeenAt !== record.firstSeenAt ||
      previous.lastHitAt !== record.lastHitAt
    ) {
      return false
    }
  }
  return true
}

/** Default sidecar location for a memory directory. */
export function indexPathFor(memoryDir: string): string {
  return join(memoryDir, INDEX_FILE)
}
