export type MemoryTarget = 'memory' | 'user'

/**
 * Thrown instead of silently truncating.
 *
 * Truncation loses rules, which is exactly how a memory file quietly goes wrong:
 * the write looks successful and the next request is missing a constraint. The
 * inherited Hermes file is already 68% over its cap, so refusing the write is
 * what forces a real compression pass.
 */
export class CapExceededError extends Error {
  constructor(
    readonly target: MemoryTarget,
    readonly current: number,
    readonly cap: number,
  ) {
    super(`${target} memory is ${current} characters, over the ${cap} cap by ${current - cap}`)
    this.name = 'CapExceededError'
  }
}

export function assertWithinCap(target: MemoryTarget, text: string, cap: number): void {
  if (text.length > cap) throw new CapExceededError(target, text.length, cap)
}

export interface CapReport {
  current: number
  cap: number
  percent: number
  over: boolean
}

export function capReport(text: string, cap: number): CapReport {
  return {
    current: text.length,
    cap,
    // A zero or negative cap is a misconfiguration, not a division-by-zero.
    percent: cap > 0 ? Math.floor((text.length * 100) / cap) : 0,
    over: text.length > cap,
  }
}
