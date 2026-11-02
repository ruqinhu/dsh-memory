import { describe, expect, it } from 'vitest'
import { entryId, isEntryId, resolveEntry, targetOfId } from '../src/store/ids.js'

describe('entryId', () => {
  it('is stable for the same text', () => {
    expect(entryId('memory', '止损 2.96')).toBe(entryId('memory', '止损 2.96'))
  })

  it('ignores surrounding whitespace, because splitEntries trims', () => {
    expect(entryId('memory', '  止损 2.96 \n')).toBe(entryId('memory', '止损 2.96'))
  })

  it('distinguishes the two documents', () => {
    // The same sentence means different things as a rule and as a profile fact; if
    // the ids collided, memory_get would have to guess which document to read.
    expect(entryId('memory', '偏好简洁')).not.toBe(entryId('user', '偏好简洁'))
  })

  it('changes when the rule changes', () => {
    // This is the property that keeps a stale reference from resolving to a rule
    // the owner has since rewritten.
    expect(entryId('memory', '止损 2.96')).not.toBe(entryId('memory', '止损 3.02'))
  })

  it('uses the document prefix and a fixed-width hex body', () => {
    expect(entryId('memory', 'x')).toMatch(/^m-[0-9a-f]{10}$/)
    expect(entryId('user', 'x')).toMatch(/^u-[0-9a-f]{10}$/)
  })
})

describe('id recognition', () => {
  it('recognises ids and rejects other strings', () => {
    expect(isEntryId('m-0123456789')).toBe(true)
    expect(isEntryId('u-abcdef0123')).toBe(true)
    expect(isEntryId('0123456789')).toBe(false)
    expect(isEntryId('m-0123')).toBe(false)
    expect(isEntryId('x-0123456789')).toBe(false)
  })

  it('maps a prefix to its document', () => {
    expect(targetOfId('m-0123456789')).toBe('memory')
    expect(targetOfId('u-0123456789')).toBe('user')
    expect(targetOfId('nope')).toBeUndefined()
  })
})

describe('resolveEntry', () => {
  const documents = {
    memory: '止损 2.96\n§\n走弱日不追高',
    user: '偏好简洁',
  }

  it('finds an entry in each document', () => {
    expect(resolveEntry(documents, entryId('memory', '走弱日不追高'))).toEqual({
      target: 'memory',
      entry: '走弱日不追高',
    })
    expect(resolveEntry(documents, entryId('user', '偏好简洁'))).toEqual({
      target: 'user',
      entry: '偏好简洁',
    })
  })

  it('returns undefined for an id that is no longer in the document', () => {
    // The normal case for a stale index: the entry was compressed away since the
    // index the model was shown was rendered.
    expect(resolveEntry(documents, 'm-0000000000')).toBeUndefined()
  })

  it('returns undefined for a malformed id instead of scanning', () => {
    expect(resolveEntry(documents, 'memory')).toBeUndefined()
  })
})
