import { splitEntries } from '../store/parse.js'
import { entryId, type ResolvedEntry } from '../store/ids.js'
import { scoreEntries } from '../inject/relevance.js'

/**
 * 召回读取的原始文档。
 *
 * 与 `MemoryFiles.read` 结构相同，但有意更窄：召回只需要读，而一个不会写的接缝
 * 不可能破坏任何东西。
 */
export interface RecallSource {
  memory: string
  user: string
}

export interface RecallResult {
  /** 要前置到本回合的文本；没有相关内容时为 `''`。 */
  block: string
  /**
   * 一行说明召回了什么，例如 `🧠 召回 2 条记忆`；没有召回时为 `''`。
   *
   * 它存在的意义是让操作者**看见**记忆被查过。Hermes 学到过同一课
   * （`describe_recall`）：没有确定性的指示，一个沉默的模型和一条坏掉的召回链路
   * 完全无法区分 —— 这个部署在投递侧已经吃过同样的亏。
   */
  indicator: string
}

export interface RecallOptions {
  /** 注入字符的硬上限。召回成本是每回合都要付的。 */
  budgetChars?: number
  /**
   * 用真正进入注入块的条目回调一次。
   *
   * 召回是唯一知道「哪些规则对某个请求有用」的地方，因此也是唯一能喂养用量统计的
   * 地方 —— 那是后续压缩需要的证据。做成回调而不是返回字段，是为了让注入块格式
   * （模型读的那部分）与簿记保持独立。
   */
  onHits?: (hits: readonly ResolvedEntry[]) => void
}

/** 默认上限：舒适地低于文档 6000 字符的内联预算。 */
export const DEFAULT_RECALL_BUDGET = 1_500

interface Candidate {
  target: 'memory' | 'user'
  entry: string
  score: number
}

/** 注入的一行：先是模型可以引用的 ID，然后是规则本身。 */
function renderCandidate(entry: ResolvedEntry): string {
  return `- [${entryId(entry.target, entry.entry)}] ${entry.entry.trim()}`
}

/**
 * 针对纯文件文档的关键词召回。
 *
 * 只做一种实现，而不是抽象出多种后端：只有一个适配器的服务接口是假想的接缝，而
 * 这层间接的成本现在就付，它预期的变化却可能永远不来。真出现第二个后端时，这个
 * 形状就是它需要满足的契约。
 *
 * 打分交给 `scoreEntries`，它按命中的查询词计数，并且已经处理了中文连续片段 ——
 * 不会按字拆分。
 */
export class FileRecall {
  private readonly budgetChars: number
  private readonly onHits?: RecallOptions['onHits']

  constructor(
    private readonly source: RecallSource,
    options: RecallOptions = {},
  ) {
    this.budgetChars = options.budgetChars ?? DEFAULT_RECALL_BUDGET
    this.onHits = options.onHits
  }

  /**
   * 为 `query` 挑出值得注入的条目。
   *
   * 按分数从高到低取，直到预算花完，于是一个能匹配半份文档的宽泛查询仍然给出最具体
   * 的那几条，而不是文档里任意的前缀。放不进剩余预算的条目会被跳过而不是截断：半条
   * 规则比没有规则更糟，因为它读起来像完整的。
   */
  prefetch(query: string): RecallResult {
    const candidates = this.rank(query)
    if (candidates.length === 0) return { block: '', indicator: '' }

    // 头部与各节标题也是注入内容的一部分，所以计入预算。把它们记在调用方账上，
    // 会让结果恰好超出它声称的上限一个头部的长度。
    const header = ['Recalled from saved memory for this turn:', '']
    const MEMORY_HEADING = ['## Long-term memory', '']
    const USER_HEADING = ['## Owner profile', '']
    let used = [header, MEMORY_HEADING, USER_HEADING].flat().join('\n').length

    const chosen: Candidate[] = []
    for (const candidate of candidates) {
      const rendered = renderCandidate(candidate)
      // 放不下的条目跳过而非截断：半条规则读起来像完整的一条，比没有更糟。
      if (used + rendered.length + 1 > this.budgetChars) continue
      chosen.push(candidate)
      used += rendered.length + 1
    }

    if (chosen.length === 0) return { block: '', indicator: '' }
    this.reportHits(chosen)

    const memory = chosen.filter((c) => c.target === 'memory')
    const user = chosen.filter((c) => c.target === 'user')
    const parts = [...header]
    if (memory.length > 0) {
      parts.push(...MEMORY_HEADING, ...memory.map(renderCandidate), '')
    }
    if (user.length > 0) {
      parts.push(...USER_HEADING, ...user.map(renderCandidate), '')
    }

    return { block: parts.join('\n').trimEnd(), indicator: `🧠 召回 ${chosen.length} 条记忆` }
  }

  /**
   * 把选中的条目报给记录用量的地方。
   *
   * 有意吞掉异常：统计是给后续压缩用的优化项，一个会抛错的接收方不该把一次正常的
   * 召回变成一次失败的回合。
   */
  private reportHits(chosen: readonly Candidate[]): void {
    const sink = this.onHits
    if (sink === undefined) return
    try {
      sink(chosen.map((candidate) => ({ target: candidate.target, entry: candidate.entry })))
    } catch {
      // 同上：簿记永远没有资格弄坏召回。
    }
  }

  /** 给两份文档的所有条目打分，最好的在前，丢掉 0 分。 */
  private rank(query: string): Candidate[] {
    const out: Candidate[] = []
    for (const target of ['memory', 'user'] as const) {
      const text = target === 'memory' ? this.source.memory : this.source.user
      if (text.trim() === '') continue
      for (const scored of scoreEntries(query, splitEntries(text))) {
        // 0 分意味着条目里没有出现任何查询词。把那些也返回，等于每回合注入无关记忆，
        // 慢慢把工作上下文挤出去。
        if (scored.score <= 0) continue
        out.push({ target, entry: scored.entry, score: scored.score })
      }
    }
    // 同分保持文档顺序，这个顺序在多次调用之间是稳定的 —— 让同分条目在回合之间重排
    // 的召回，行为就无法复现。
    return out.sort((a, b) => b.score - a.score)
  }
}
