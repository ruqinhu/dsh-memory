import { describe, expect, it } from 'vitest'
import { AutoRecall, type AutoRecallDeps } from '../src/recall/auto-recall.js'
import type { RecallResult } from '../src/recall/file-recall.js'

/**
 * The turn-level recall driver.
 *
 * `FileRecall` answers "which entries match this text". This answers the
 * questions around it: should this turn be recalled at all, what happens when the
 * turn is interrupted, and how does the operator see that recall ran.
 *
 * Hermes splits the same work across `on_turn_start` / `prefetch` / `recall_status`
 * and gates it on `is_trivial_prompt`. OpenClaw does it with a `before-task` CLI
 * hook. This mirrors Hermes, whose ordering is the more careful of the two:
 * prefetch only on a non-trivial turn, and never against a turn that was
 * interrupted, because the next message is almost certainly a retry of the same
 * intent and a prefetch keyed on the interrupted text fires on stale context.
 */

interface Harness {
  recall: AutoRecall
  recalled: string[]
  indicators: string[]
}

function harness(options: {
  results?: Record<string, RecallResult>
  enabled?: boolean
} = {}): Harness {
  const recalled: string[] = []
  const indicators: string[] = []
  const results = options.results ?? {}

  const deps: AutoRecallDeps = {
    enabled: options.enabled ?? true,
    recall: (query) => {
      recalled.push(query)
      return results[query] ?? { block: '', indicator: '' }
    },
    report: (line) => {
      indicators.push(line)
    },
  }
  return { recall: new AutoRecall(deps), recalled, indicators }
}

const HIT: RecallResult = { block: 'Recalled from saved memory:\n- 止损 91', indicator: '🧠 召回 1 条记忆' }

describe('AutoRecall', () => {
  it('returns the block for a substantive query and reports the indicator', () => {
    const h = harness({ results: { 止损怎么设: HIT } })
    const out = h.recall.prefetch('止损怎么设')
    expect(out).toBe(HIT.block)
    expect(h.recalled).toEqual(['止损怎么设'])
    expect(h.indicators).toEqual([HIT.indicator])
  })

  it('skips a trivial turn entirely', () => {
    // Not merely "returns empty": the lookup must not run, because a trivial turn
    // that happens to match a stray term injects an unrelated rule.
    const h = harness({ results: { 好的: HIT } })
    expect(h.recall.prefetch('好的')).toBe('')
    expect(h.recalled).toEqual([])
    expect(h.indicators).toEqual([])
  })

  it('does nothing when disabled', () => {
    const h = harness({ enabled: false, results: { 止损怎么设: HIT } })
    expect(h.recall.prefetch('止损怎么设')).toBe('')
    expect(h.recalled).toEqual([])
  })

  it('returns empty without an indicator when nothing matched', () => {
    const h = harness()
    expect(h.recall.prefetch('止损怎么设')).toBe('')
    // No indicator when nothing was injected: an indicator on an empty recall
    // reports a consultation that did not happen.
    expect(h.indicators).toEqual([])
  })

  it('survives a throwing recall without breaking the turn', () => {
    const deps: AutoRecallDeps = {
      enabled: true,
      recall: () => {
        throw new Error('disk gone')
      },
      report: () => {},
    }
    // A recall failure must never fail the turn: memory is an optimisation, and
    // taking the agent down because a file was unreadable trades a degraded turn
    // for no turn at all.
    expect(new AutoRecall(deps).prefetch('止损怎么设')).toBe('')
  })

  it('never reports the same indicator twice in a row', () => {
    // `recall_status` is documented as reflecting only the LAST prefetch. Repeating
    // an identical indicator makes the operator unable to tell a fresh recall from
    // a stale one still being displayed.
    const h = harness({ results: { 止损怎么设: HIT } })
    h.recall.prefetch('止损怎么设')
    h.recall.prefetch('止损怎么设')
    expect(h.indicators).toEqual([HIT.indicator])
  })

  it('reports again once the count changes', () => {
    const two: RecallResult = { block: 'x', indicator: '🧠 召回 2 条记忆' }
    const h = harness({ results: { 止损怎么设: HIT, 走弱日上沿: two } })
    h.recall.prefetch('止损怎么设')
    h.recall.prefetch('走弱日上沿')
    expect(h.indicators).toEqual([HIT.indicator, two.indicator])
  })
})
