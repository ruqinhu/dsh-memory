import { describe, expect, it } from 'vitest'
import { assertWithinCap, CapExceededError, capReport } from '../src/store/caps.js'

describe('assertWithinCap', () => {
  it('accepts text exactly at the cap', () => {
    expect(() => assertWithinCap('memory', 'abc', 3)).not.toThrow()
  })

  it('rejects text one character over the cap', () => {
    expect(() => assertWithinCap('memory', 'abcd', 3)).toThrow(CapExceededError)
  })

  it('reports target, current and cap on the error', () => {
    try {
      assertWithinCap('memory', 'abcdef', 3)
      expect.unreachable()
    } catch (error) {
      const exceeded = error as CapExceededError
      expect(exceeded.target).toBe('memory')
      expect(exceeded.current).toBe(6)
      expect(exceeded.cap).toBe(3)
      expect(exceeded.message).toContain('6')
      expect(exceeded.message).toContain('3')
    }
  })

  it('counts characters, not bytes, so CJK is not penalised', () => {
    // Each CJK character is one character but three UTF-8 bytes.
    expect(() => assertWithinCap('user', '买点口径', 4)).not.toThrow()
  })
})

describe('capReport', () => {
  it('reports usage and percentage', () => {
    expect(capReport('abc', 6)).toEqual({ current: 3, cap: 6, percent: 50, over: false })
  })

  it('flags an over-cap document', () => {
    expect(capReport('abcdefgh', 4)).toEqual({ current: 8, cap: 4, percent: 200, over: true })
  })

  it('treats an empty document as within cap', () => {
    expect(capReport('', 100)).toEqual({ current: 0, cap: 100, percent: 0, over: false })
  })

  it('does not divide by zero when the cap is misconfigured to 0', () => {
    const report = capReport('abc', 0)
    expect(report.percent).toBe(0)
    expect(Number.isFinite(report.percent)).toBe(true)
    expect(report.over).toBe(true)
  })
})
