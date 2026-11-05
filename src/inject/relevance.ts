export interface ScoredEntry {
  entry: string
  score: number
}

/**
 * 把查询切成候选词。
 *
 * ASCII 词至少要两个字符才有用（单个字母几乎命中一切）。
 *
 * 中文是关键的那一类。整段保留 —— 也就是之前的行为 —— 只在查询恰好是条目子串时
 * 命中，于是自然写出的 `止损怎么设` 对条目 `止损 2.96` 得 0 分：`止损怎么设` 这个
 * 整段并不出现在条目里，而更小的单元从来没有被产生过。召回随后静默返回空，看起来
 * 和「没有相关记忆」一模一样。
 *
 * 二元组是没有词分隔符的语言的标准解法：`止损怎么设` 切成 `止损`、`损怎`、`么设`，
 * 含 `止损` 的条目就能命中的确是用户打出来的那个词。单字仍然不输出 —— 它们匹配得
 * 太宽，算不上相关性的证据。
 */
export function terms(query: string): string[] {
  const ascii = query.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []
  const runs = query.match(/[\u4e00-\u9fff]+/g) ?? []

  const cjk: string[] = []
  for (const run of runs) {
    if (run.length === 1) {
      // 单字查询的全部证据就这一个字；丢掉它会让单字搜索变得不可能，而不只是变吵。
      cjk.push(run)
      continue
    }
    for (let i = 0; i + 1 < run.length; i++) cjk.push(run.slice(i, i + 2))
  }

  return [...new Set([...ascii, ...cjk])]
}

/** 按条目包含多少个查询词来打分。 */
export function scoreEntries(query: string, entries: readonly string[]): ScoredEntry[] {
  const needles = terms(query)
  if (needles.length === 0) return entries.map((entry) => ({ entry, score: 0 }))

  return entries.map((entry) => {
    const haystack = entry.toLowerCase()
    let score = 0
    for (const needle of needles) if (haystack.includes(needle)) score++
    return { entry, score }
  })
}
