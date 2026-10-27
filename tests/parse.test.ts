import { describe, expect, it } from 'vitest'
import { joinEntries, splitEntries } from '../src/store/parse.js'

describe('splitEntries', () => {
  it('splits on the section separator and trims each entry', () => {
    expect(splitEntries('first rule\n§\nsecond rule')).toEqual(['first rule', 'second rule'])
  })

  it('drops blank entries', () => {
    expect(splitEntries('a\n§\n\n§\nb')).toEqual(['a', 'b'])
  })

  it('returns a single entry when there is no separator', () => {
    expect(splitEntries('only one')).toEqual(['only one'])
  })

  it('returns an empty array for whitespace-only input', () => {
    expect(splitEntries('   ')).toEqual([])
  })

  it('preserves internal newlines inside one entry', () => {
    expect(splitEntries('line1\nline2\n§\nnext')).toEqual(['line1\nline2', 'next'])
  })
})

describe('joinEntries', () => {
  it('joins with the canonical separator surrounded by newlines', () => {
    expect(joinEntries(['a', 'b'])).toBe('a\n§\nb')
  })

  it('round-trips through splitEntries', () => {
    const entries = ['买点口径v2:走弱日上沿=昨收下方2~3%', '止损2.96/走弱3.02']
    expect(splitEntries(joinEntries(entries))).toEqual(entries)
  })

  it('drops blank entries rather than creating empty rules', () => {
    expect(joinEntries(['a', '  ', 'b'])).toBe('a\n§\nb')
  })

  it('returns an empty string for no entries', () => {
    expect(joinEntries([])).toBe('')
  })
})
