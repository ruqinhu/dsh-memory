import { createHash } from 'node:crypto'
import type { MemoryTarget } from './caps.js'
import { splitEntries } from './parse.js'

/**
 * Stable identifiers for memory entries.
 *
 * The identifiers exist because an index is only useful if the model can get back
 * from it. Before this, the over-budget injection rendered each entry as an
 * 80-character headline and told the model to call `memory_search`, which meant
 * the only way to read a truncated rule was to guess keywords that happened to
 * appear in it. An identifier turns that guess into a jump: `memory_get('m-…')`
 * returns the entry the index just named.
 *
 * They are derived from the entry text rather than assigned by position on
 * purpose. A positional id (`entry 7`) renumbers on every compression pass, so
 * every reference the model wrote in the previous turn silently points at a
 * different rule. A content hash changes only when the rule itself changes, which
 * is exactly when the old reference should stop resolving.
 *
 * Hashes do not go into `MEMORY.md`/`USER.md`. The documents are the owner's, and
 * an id in the text would be one more thing for a compression pass to get wrong —
 * these are recomputed from the documents on every load, so an existing file needs
 * no migration and a hand-edited entry simply gets a new id.
 */
const PREFIX: Record<MemoryTarget, string> = { memory: 'm', user: 'u' }

/**
 * Hex characters kept from the SHA-256 digest.
 *
 * 40 bits. At the caps these documents run at (a few hundred entries at most)
 * a collision is about as likely as the process being killed at the exact
 * millisecond that would matter; a shorter id saves five characters on a line
 * that is rendered once per entry, and five characters times a hundred entries is
 * a real slice of an index that exists to be small.
 */
export const ID_HEX_LENGTH = 10

export function entryId(target: MemoryTarget, entry: string): string {
  const digest = createHash('sha256').update(`${target}\u0000${entry.trim()}`).digest('hex')
  return `${PREFIX[target]}-${digest.slice(0, ID_HEX_LENGTH)}`
}

const ID_PATTERN = new RegExp(`^(m|u)-[0-9a-f]{${ID_HEX_LENGTH}}$`)

export function isEntryId(value: string): boolean {
  return ID_PATTERN.test(value)
}

/** The document an id belongs to, or `undefined` when it is not an id at all. */
export function targetOfId(id: string): MemoryTarget | undefined {
  const match = ID_PATTERN.exec(id)
  if (match === null) return undefined
  return match[1] === 'm' ? 'memory' : 'user'
}

export interface ResolvedEntry {
  target: MemoryTarget
  entry: string
}

/**
 * Find the entry an id names, searching the document its prefix points at.
 *
 * Recomputing every id in the document is O(entries) and runs only on an explicit
 * `memory_get`, so there is no reason to maintain a reverse lookup that could
 * drift from the text.
 */
export function resolveEntry(
  documents: Record<MemoryTarget, string>,
  id: string,
): ResolvedEntry | undefined {
  const target = targetOfId(id)
  if (target === undefined) return undefined
  for (const entry of splitEntries(documents[target])) {
    if (entryId(target, entry) === id) return { target, entry }
  }
  return undefined
}
