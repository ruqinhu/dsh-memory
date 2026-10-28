import { describe, expect, it } from 'vitest'
import { FileRecall, type RecallSource } from '../src/recall/file-recall.js'

/**
 * The recall seam.
 *
 * Memory here is injected whole while it fits the inline budget, so recall is not
 * needed yet. It becomes needed the moment the documents outgrow that budget and the
 * injection switches to an entry index — at which point something has to pick which
 * entries to surface for a given turn.
 *
 * Defining the seam now, with one real implementation, is deliberate: OpenClaw and
 * Hermes both grew a recall hook (they call it `before_agent_start` / `prefetch`) and
 * both had to bolt it on afterwards. The interface is cheap to hold still and
 * expensive to retrofit.
 */

function source(memory: string, user = ''): RecallSource {
  return { memory, user }
}

describe('FileRecall', () => {
  it('returns nothing and no indicator when the query matches nothing', () => {
    const recall = new FileRecall(source('止损 2.96\n§\n买点口径 v2'))

    const result = recall.prefetch('朋友圈文案')

    expect(result.block).toBe('')
    // No indicator when nothing was recalled: an indicator claiming recall of zero
    // entries is worse than silence, because it implies memory was consulted and
    // found wanting when in fact nothing relevant existed.
    expect(result.indicator).toBe('')
  })

  it('surfaces the entries that match the query', () => {
    const recall = new FileRecall(source('止损 2.96\n§\n买点口径 v2\n§\n朋友圈风格'))

    const result = recall.prefetch('止损怎么设')

    expect(result.block).toContain('止损 2.96')
    expect(result.block).not.toContain('朋友圈风格')
  })

  it('distinguishes memory entries from owner profile entries', () => {
    // A recalled rule and a recalled preference are different claims; collapsing them
    // into one undifferentiated list makes the model guess which is authoritative.
    const recall = new FileRecall(source('止损 2.96', '偏好：简短回答'))

    const result = recall.prefetch('简短')

    expect(result.block).toContain('偏好')
    expect(result.indicator).toContain('1')
  })

  it('reports the number of entries recalled', () => {
    const recall = new FileRecall(source('止损 2.96\n§\n止损口径\n§\n朋友圈风格'))

    const result = recall.prefetch('止损')

    expect(result.indicator).toContain('2')
  })

  it('caps how much it injects', () => {
    // Recall runs before every turn, so its cost is paid on every request. Without a
    // budget one broad query would re-inject most of the document and defeat the point
    // of switching to an index in the first place.
    const many = Array.from({ length: 200 }, (_, i) => `条目${i}: 止损规则 ${i} ${'细节'.repeat(30)}`)
    const recall = new FileRecall(source(many.join('\n§\n')), { budgetChars: 800 })

    const result = recall.prefetch('止损')

    expect(result.block.length).toBeLessThanOrEqual(800)
  })

  it('prefers higher-scoring entries when the budget forces a choice', () => {
    // Two entries match; only one fits. The one matching more query terms is the one
    // worth spending the budget on.
    const recall = new FileRecall(
      source(['止损', `止损 口径 走弱日 上沿 昨收 ${'x'.repeat(400)}`].join('\n§\n')),
      { budgetChars: 500 },
    )

    const result = recall.prefetch('止损 口径 走弱日')

    expect(result.block).toContain('走弱日')
  })

  it('does not claim recall when the budget admits nothing', () => {
    const recall = new FileRecall(source(`止损 ${'x'.repeat(500)}`), { budgetChars: 10 })

    const result = recall.prefetch('止损')

    expect(result.block).toBe('')
    expect(result.indicator).toBe('')
  })

  it('is a no-op on empty documents', () => {
    const recall = new FileRecall(source('', ''))

    const result = recall.prefetch('anything')

    expect(result.block).toBe('')
    expect(result.indicator).toBe('')
  })
})
