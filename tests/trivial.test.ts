import { describe, expect, it } from 'vitest'
import { isTrivialQuery } from '../src/recall/trivial.js'

/**
 * The gate that keeps recall off trivial turns.
 *
 * Hermes calls this `is_trivial_prompt` and wraps its whole `prefetch_all` call in
 * it: a turn whose text carries no semantic signal gets no recall at all. The
 * reason is cost, not purity — recall is paid on every turn, and "好的" / "继续"
 * match nothing while still spending a lookup and, worse, can match *something*
 * by accident and inject an unrelated rule into a turn about nothing.
 *
 * OpenClaw has no equivalent and pays for it: `before-task` recalls on every
 * invocation including the ones that carry three words.
 */

describe('isTrivialQuery', () => {
  it('treats an empty or whitespace-only query as trivial', () => {
    expect(isTrivialQuery('')).toBe(true)
    expect(isTrivialQuery('   ')).toBe(true)
    expect(isTrivialQuery('\n\t ')).toBe(true)
  })

  it('treats bare acknowledgements as trivial', () => {
    for (const text of ['好的', 'ok', 'OK', '嗯', '收到', '继续', 'yes', '辛苦了']) {
      expect(isTrivialQuery(text), text).toBe(true)
    }
  })

  it('ignores surrounding punctuation and trailing thanks', () => {
    // Real turns arrive with punctuation attached; comparing the raw string would
    // let "好的。" through while "好的" is gated.
    expect(isTrivialQuery('好的。')).toBe(true)
    expect(isTrivialQuery('ok!')).toBe(true)
    expect(isTrivialQuery('收到，谢谢')).toBe(true)
    expect(isTrivialQuery('嗯嗯')).toBe(true)
  })

  it('does not gate a query that carries a real question', () => {
    for (const text of [
      '止损怎么设',
      '帮我看看生益电子',
      'OK 那明天呢',
      '收到，那止盈位放哪',
      '继续，把周报发我',
    ]) {
      expect(isTrivialQuery(text), text).toBe(false)
    }
  })

  it('does not gate a short but meaningful technical token', () => {
    // Length alone is not a signal: these are one or two characters of dense
    // meaning, and gating them would silently disable recall for exactly the
    // terse prompts this owner sends.
    for (const text of ['跌停', '止损', '周报', 'MA20']) {
      expect(isTrivialQuery(text), text).toBe(false)
    }
  })
})
