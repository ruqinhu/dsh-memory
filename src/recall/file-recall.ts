import { splitEntries } from '../store/parse.js'
import { entryId, type ResolvedEntry } from '../store/ids.js'
import { scoreEntries } from '../inject/relevance.js'

/**
 * The raw documents recall reads from.
 *
 * Structurally identical to `MemoryFiles.read`, but narrower on purpose: recall only
 * needs to read, and a seam that cannot write cannot corrupt anything.
 */
export interface RecallSource {
  memory: string
  user: string
}

export interface RecallResult {
  /** Text to prepend to the turn, or `''` when nothing relevant was found. */
  block: string
  /**
   * One short line stating what was recalled, e.g. `🧠 召回 2 条记忆`, or `''`.
   *
   * This exists so the operator can SEE that memory was consulted. Hermes learnt the
   * same lesson (`describe_recall`): without a deterministic indicator, a silent model
   * and a broken recall path are indistinguishable — the same failure this deployment
   * already had with delivery.
   */
  indicator: string
}

export interface RecallOptions {
  /** Hard ceiling on injected characters. Recall cost is paid on every turn. */
  budgetChars?: number
  /**
   * Called with the entries that actually made it into the block.
   *
   * Recall is the only place that knows which rules were useful for a request, so
   * it is the only place that can feed the usage statistics a compression pass
   * later needs. Kept as a callback rather than a return field so the block format
   * — the part the model reads — stays independent of the bookkeeping.
   */
  onHits?: (hits: readonly ResolvedEntry[]) => void
}

/** Default ceiling: comfortably below the 6000-char inline budget for the documents. */
export const DEFAULT_RECALL_BUDGET = 1_500

interface Candidate {
  target: 'memory' | 'user'
  entry: string
  score: number
}

/** One injected line: the id the model can quote back, then the rule itself. */
function renderCandidate(entry: ResolvedEntry): string {
  return `- [${entryId(entry.target, entry.entry)}] ${entry.entry.trim()}`
}

/**
 * Keyword recall over the plain-file documents.
 *
 * One implementation, not an abstraction over many: a service interface with a single
 * adapter would be a hypothetical seam, and the cost of the indirection is paid now
 * while the variation it anticipates may never arrive. If a second backend is ever
 * added, this shape is what it will have to satisfy.
 *
 * Scoring is delegated to `scoreEntries`, which counts matching query terms and
 * already handles CJK runs without splitting them per character.
 */
export class FileRecall {
  private readonly budgetChars: number
  private readonly onHits?: RecallOptions['onHits']

  constructor(
    private readonly source: RecallSource,
    options: RecallOptions = {},
  ) {
    this.budgetChars = options.budgetChars ?? DEFAULT_RECALL_BUDGET
    this.onHits = options.onHits
  }

  /**
   * Pick the entries worth injecting for `query`.
   *
   * Entries are taken highest-score first until the budget is spent, so a broad query
   * that matches half the document still yields the most specific entries rather than
   * an arbitrary prefix. An entry that does not fit the remaining budget is skipped
   * rather than truncated: half a rule is worse than no rule, because it reads as
   * complete.
   */
  prefetch(query: string): RecallResult {
    const candidates = this.rank(query)
    if (candidates.length === 0) return { block: '', indicator: '' }

    // The header and section headings are part of what gets injected, so they count
    // against the budget. Charging them to the caller instead let the result overshoot
    // its stated ceiling by exactly the header length.
    const header = ['Recalled from saved memory for this turn:', '']
    const MEMORY_HEADING = ['## Long-term memory', '']
    const USER_HEADING = ['## Owner profile', '']
    let used = [header, MEMORY_HEADING, USER_HEADING].flat().join('\n').length

    const chosen: Candidate[] = []
    for (const candidate of candidates) {
      const rendered = renderCandidate(candidate)
      // An entry that does not fit is skipped rather than truncated: half a rule reads
      // as a complete one, which is worse than having no rule at all.
      if (used + rendered.length + 1 > this.budgetChars) continue
      chosen.push(candidate)
      used += rendered.length + 1
    }

    if (chosen.length === 0) return { block: '', indicator: '' }
    this.reportHits(chosen)

    const memory = chosen.filter((c) => c.target === 'memory')
    const user = chosen.filter((c) => c.target === 'user')
    const parts = [...header]
    if (memory.length > 0) {
      parts.push(...MEMORY_HEADING, ...memory.map(renderCandidate), '')
    }
    if (user.length > 0) {
      parts.push(...USER_HEADING, ...user.map(renderCandidate), '')
    }

    return { block: parts.join('\n').trimEnd(), indicator: `🧠 召回 ${chosen.length} 条记忆` }
  }

  /**
   * Report the chosen entries to whoever records usage.
   *
   * Swallowed on purpose: statistics are an optimisation for a later compression
   * pass, and a throwing sink must not turn a working recall into a failed turn.
   */
  private reportHits(chosen: readonly Candidate[]): void {
    const sink = this.onHits
    if (sink === undefined) return
    try {
      sink(chosen.map((candidate) => ({ target: candidate.target, entry: candidate.entry })))
    } catch {
      // See above: bookkeeping never gets to break recall.
    }
  }

  /** Score every entry from both documents, best first, dropping zero scores. */
  private rank(query: string): Candidate[] {
    const out: Candidate[] = []
    for (const target of ['memory', 'user'] as const) {
      const text = target === 'memory' ? this.source.memory : this.source.user
      if (text.trim() === '') continue
      for (const scored of scoreEntries(query, splitEntries(text))) {
        // A zero score means no query term appears in the entry. Returning those would
        // inject unrelated memory on every turn and slowly crowd out working context.
        if (scored.score <= 0) continue
        out.push({ target, entry: scored.entry, score: scored.score })
      }
    }
    // Ties keep document order, which is stable across calls — recall that reshuffles
    // equal-scoring entries between turns makes behaviour irreproducible.
    return out.sort((a, b) => b.score - a.score)
  }
}
