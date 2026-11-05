export type MemoryTarget = 'memory' | 'user'

/**
 * 超限时抛出，而不是悄悄截断。
 *
 * 截断会丢规则，这正是记忆文件悄悄出错的典型方式：写入看起来成功了，下一次请求
 * 却少了某条约束。参照的 Hermes 文件已经超出上限 68%，所以「拒绝写入」才是逼出
 * 一次真正压缩的手段。
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
    // 上限为 0 或负数属于配置错误，不是除零。
    percent: cap > 0 ? Math.floor((text.length * 100) / cap) : 0,
    over: text.length > cap,
  }
}
