/** The separator used by the inherited Hermes memory files. */
const SEPARATOR = '§'

/**
 * Split a memory document into trimmed, non-empty entries.
 *
 * The `§` separator is load-bearing: entries are complete rules, and a split
 * that drops blank fragments keeps a stray double separator from creating an
 * empty rule that then gets written back.
 */
export function splitEntries(text: string): string[] {
  const entries: string[] = []
  for (const part of text.split(SEPARATOR)) {
    const trimmed = part.trim()
    if (trimmed !== '') entries.push(trimmed)
  }
  return entries
}

/** Join entries with the canonical separator. The trailing newline is the writer's job. */
export function joinEntries(entries: readonly string[]): string {
  const kept: string[] = []
  for (const entry of entries) {
    const trimmed = entry.trim()
    if (trimmed !== '') kept.push(trimmed)
  }
  return kept.join(`\n${SEPARATOR}\n`)
}
