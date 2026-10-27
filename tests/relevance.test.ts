import { describe, expect, it } from 'vitest'
import { scoreEntries, terms } from '../src/inject/relevance.js'

const entries = [
  '买点口径v2:走弱日上沿=昨收下方2~3%',
  '止损2.96/走弱3.02/锁利3.44',
  '朋友圈风格:开头XX的PLOG',
  '五一假期去大兴安岭',
]

describe('terms', () => {
  it('keeps CJK runs intact', () => {
    expect(terms('买点口径')).toEqual(['买点口径'])
  })

  it('lowercases ASCII words', () => {
    expect(terms('MEMORY cap')).toEqual(['memory', 'cap'])
  })

  it('ignores single-character ASCII tokens', () => {
    expect(terms('a bc')).toEqual(['bc'])
  })

  it('returns every distinct term once', () => {
    expect(terms('止损 止损')).toEqual(['止损'])
  })
})

describe('scoreEntries', () => {
  it('scores an entry containing a query term', () => {
    const scored = scoreEntries('买点 止损', entries)
    expect(scored.find((s) => s.entry.includes('朋友圈'))?.score).toBe(0)
    expect(scored.find((s) => s.entry.includes('买点'))?.score).toBeGreaterThan(0)
  })

  it('ranks an entry matching more terms higher', () => {
    const scored = scoreEntries('止损 走弱 锁利', entries)
    const stopLoss = scored.find((s) => s.entry.includes('止损'))
    const buyPoint = scored.find((s) => s.entry.includes('买点口径'))
    expect(stopLoss!.score).toBeGreaterThan(buyPoint!.score)
  })

  it('returns zero scores when the query has no usable terms', () => {
    const scored = scoreEntries('a', entries)
    expect(scored.every((s) => s.score === 0)).toBe(true)
  })

  it('keeps every entry in the result, scored or not', () => {
    expect(scoreEntries('买点', entries)).toHaveLength(entries.length)
  })
})
