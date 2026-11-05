import type { RecallResult } from './file-recall.js'
import { isTrivialQuery } from './trivial.js'

export interface AutoRecallDeps {
  /** 自动召回总开关。 */
  enabled: boolean
  /**
   * 召回实现，用本回合的文本调用。
   *
   * 通过注入而不是在这里构造，是为了让本驱动只负责策略 —— 门控、去重、失败隔离 ——
   * 而把查找本身留成可替换的。
   */
  recall: (query: string) => RecallResult
  /** 在有值得展示的指示行时接收它。 */
  report: (line: string) => void
}

/**
 * 每回合召回，规则沿用 Hermes 摸出来的那套。
 *
 * 三条规则都有承载作用，每条背后都有一次失败：
 *
 * 1. **琐碎回合不召回。** 不是查完再丢弃，而是根本不查。`好的` 靠一个字就能命中
 *    大半条目，查它不只是白读一次，而是把一条无关规则塞进一个什么都没问的回合。
 * 2. **召回失败绝不让回合失败。** 记忆是优化项；把回合和召回一起丢掉，等于用变差的
 *    回答换来没有回答。
 * 3. **指示只报一次，不是每回合都报。** Hermes 把 `recall_status` 定义为只反映最近
 *    一次 prefetch，正是这个理由：一行永远不变的字就不再是信息，而是背景板，然后
 *    坏掉的召回和沉默的召回又长得一模一样。
 */
export class AutoRecall {
  private lastIndicator = ''

  constructor(private readonly deps: AutoRecallDeps) {}

  /**
   * 本回合要注入的块，或者 `''`。
   *
   * 调用方负责把结果前置到本回合的上下文；指示行通过 `report` 交付而不是作为返回值，
   * 因为它是给操作者看的，绝不能当成记忆递给模型。
   */
  prefetch(query: string): string {
    if (!this.deps.enabled) return ''
    if (isTrivialQuery(query)) return ''

    let result: RecallResult
    try {
      result = this.deps.recall(query)
    } catch {
      // 有意吞掉：一次失败的召回不能让回合跟着倒下。
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
