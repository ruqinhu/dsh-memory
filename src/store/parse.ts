/** 继承自 Hermes 的记忆文件使用的分隔符。 */
const SEPARATOR = '§'

/**
 * 把一份记忆文档切成去空白、非空的条目。
 *
 * `§` 分隔符是有承载作用的：每个条目都是一条完整规则，而丢掉空片段的切法能让
 * 一个多写出来的分隔符不产生空规则 —— 否则这条空规则还会被再写回去。
 */
export function splitEntries(text: string): string[] {
  const entries: string[] = []
  for (const part of text.split(SEPARATOR)) {
    const trimmed = part.trim()
    if (trimmed !== '') entries.push(trimmed)
  }
  return entries
}

/** 用规范分隔符重新拼接条目。结尾换行由写入方负责。 */
export function joinEntries(entries: readonly string[]): string {
  const kept: string[] = []
  for (const entry of entries) {
    const trimmed = entry.trim()
    if (trimmed !== '') kept.push(trimmed)
  }
  return kept.join(`\n${SEPARATOR}\n`)
}
