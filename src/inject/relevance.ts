export interface ScoredEntry {
  entry: string
  score: number
}

/**
 * Split a query into candidate terms.
 *
 * ASCII words need at least two characters to be useful (single letters match
 * almost everything).
 *
 * CJK is the interesting case. Keeping a whole run intact — the previous
 * behaviour — only matches when the query happens to be a substring of the entry,
 * so the natural query `止损怎么设` scored zero against the entry `止损 2.96`: the
 * run `止损怎么设` does not appear in it, and no smaller unit was ever produced.
 * Recall then silently returned nothing, which looks identical to "no memory is
 * relevant".
 *
 * Bigrams are the standard fix for languages without word separators: `止损怎么设`
 * yields `止损`, `损怎`, `么设`, so the entry containing `止损` matches on a term
 * the user actually typed. Single characters are still not emitted — they match
 * too broadly to be evidence of relevance.
 */
export function terms(query: string): string[] {
  const ascii = query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []
  const runs = query.match(/[\u4e00-\u9fff]+/g) ?? []

  const cjk: string[] = []
  for (const run of runs) {
    if (run.length === 1) {
      // A one-character query is all the evidence there is; dropping it would make
      // single-character searches impossible rather than merely noisy.
      cjk.push(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i++) cjk.push(run.slice(i, i + 2))
  }

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
