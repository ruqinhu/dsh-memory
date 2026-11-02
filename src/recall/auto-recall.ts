import type { RecallResult } from './file-recall.js'
import { isTrivialQuery } from './trivial.js'

export interface AutoRecallDeps {
  /** Whether automatic per-turn recall is on at all. */
  enabled: boolean
  /**
   * The recall implementation, called with the turn's text.
   *
   * Injected rather than constructed here so the driver owns only the policy —
   * gating, deduplication, failure isolation — and the lookup stays replaceable.
   */
  recall: (query: string) => RecallResult
  /** Receives the indicator line when one is worth showing. */
  report: (line: string) => void
}

/**
 * Per-turn recall, with the policy Hermes settled on.
 *
 * Three rules are load-bearing and each has a failure behind it:
 *
 * 1. **A trivial turn is not recalled.** Not skipped after the fact — the lookup
 *    never runs. `好的` matches most entries on one character, so looking it up
 *    does not merely waste a read, it injects an unrelated rule into a turn that
 *    was about nothing.
 * 2. **A recall failure never fails the turn.** Memory is an optimisation; losing
 *    the turn as well as the recall trades a degraded answer for no answer.
 * 3. **An indicator is reported once, not every turn.** Hermes documents
 *    `recall_status` as reflecting only the last prefetch for this reason: a line
 *    that never changes stops being information and becomes furniture, and then a
 *    broken recall and a silent one look the same.
 */
export class AutoRecall {
  private lastIndicator = ''

  constructor(private readonly deps: AutoRecallDeps) {}

  /**
   * The block to inject for this turn, or `''`.
   *
   * The caller prepends the result to the turn's context; the indicator is
   * delivered through `report`, not returned, because it is operator-facing and
   * must not be handed to the model as if it were memory.
   */
  prefetch(query: string): string {
    if (!this.deps.enabled) return ''
    if (isTrivialQuery(query)) return ''

    let result: RecallResult
    try {
      result = this.deps.recall(query)
    } catch {
      // Swallowed on purpose: a failed recall must not take the turn down.
      return ''
    }

    if (result.block === '') return ''

    if (result.indicator !== '' && result.indicator !== this.lastIndicator) {
      this.lastIndicator = result.indicator
      this.deps.report(result.indicator)
    }
    return result.block
  }
}
