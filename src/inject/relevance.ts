export interface ScoredEntry {
  entry: string
  score: number
}

/**
 * Split a query into candidate terms.
 *
 * CJK runs stay intact — splitting them per character would match almost every
 * entry — while ASCII words need at least two characters to be useful.
 */
export function terms(query: string): string[] {
  const ascii = query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []
  const cjk = query.match(/[\u4e00-\u9fff]{2,}/g) ?? []
  return [...new Set([...ascii, ...cjk])]
}

/** Score every entry by how many query terms it contains. */
export function scoreEntries(query: string, entries: readonly string[]): ScoredEntry[] {
  const needles = terms(query)
  if (needles.length === 0) return entries.map((entry) => ({ entry, score: 0 }))

  return entries.map((entry) => {
    const haystack = entry.toLowerCase()
    let score = 0
    for (const needle of needles) if (haystack.includes(needle)) score++
    return { entry, score }
  })
}
