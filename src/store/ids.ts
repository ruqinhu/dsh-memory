import { createHash } from 'node:crypto'
import type { MemoryTarget } from './caps.js'
import { splitEntries } from './parse.js'

/**
 * 记忆条目的稳定标识。
 *
 * 之所以要有 ID，是因为索引只有在模型能顺着跳回来时才有用。在此之前，超预算注入
 * 把每条渲染成 80 个字符的首行，然后让模型去调 `memory_search` —— 想读一条被截断
 * 的规则，只能去猜恰好出现在里面的关键词。有了 ID，这次猜测就变成一次跳转：
 * `memory_get('m-…')` 直接返回索引刚刚点名的那一条。
 *
 * ID 由条目正文派生，而不是按位置分配 —— 这是有意的。位置编号（`第 7 条`）会在每次
 * 压缩后重排，于是模型上一轮写下的每个引用都静默指向另一条规则。内容哈希只在规则
 * 本身变化时变化，而那正是旧引用应当失效的时刻。
 *
 * 哈希不写进 `MEMORY.md`/`USER.md`。文档是 owner 的，正文里多一个 ID 就给压缩多
 * 一处出错的机会；这些 ID 每次加载时从文档重算，所以已有文件零迁移，手改过的条目
 * 自然拿到新 ID。
 */
const PREFIX: Record<MemoryTarget, string> = { memory: 'm', user: 'u' }

/**
 * 从 SHA-256 摘要里保留的十六进制位数。
 *
 * 40 位。以这两份文档的规模（最多几百条）而言，碰撞的概率和「进程恰好在有意义的那
 * 一毫秒被杀掉」差不多；更短的 ID 能在每一行上省下五个字符，而这一行按条目各渲染
 * 一次，一百条乘五个字符就是索引里实打实的一块 —— 索引存在的意义正是要小。
 */
export const ID_HEX_LENGTH = 10

export function entryId(target: MemoryTarget, entry: string): string {
  const digest = createHash('sha256').update(`${target}\u0000${entry.trim()}`).digest('hex')
  return `${PREFIX[target]}-${digest.slice(0, ID_HEX_LENGTH)}`
}

const ID_PATTERN = new RegExp(`^(m|u)-[0-9a-f]{${ID_HEX_LENGTH}}$`)

export function isEntryId(value: string): boolean {
  return ID_PATTERN.test(value)
}

/** ID 所属的文档；完全不是 ID 时返回 `undefined`。 */
export function targetOfId(id: string): MemoryTarget | undefined {
  const match = ID_PATTERN.exec(id)
  if (match === null) return undefined
  return match[1] === 'm' ? 'memory' : 'user'
}

export interface ResolvedEntry {
  target: MemoryTarget
  entry: string
}

/**
 * 查找一个 ID 指向的条目，只在它前缀所示的那份文档里搜索。
 *
 * 重算文档里所有 ID 是 O(条目数)，且只在显式 `memory_get` 时执行，所以没有理由去
 * 维护一张可能和正文漂移的反向索引。
 */
export function resolveEntry(
  documents: Record<MemoryTarget, string>,
  id: string,
): ResolvedEntry | undefined {
  const target = targetOfId(id)
  if (target === undefined) return undefined
  for (const entry of splitEntries(documents[target])) {
    if (entryId(target, entry) === id) return { target, entry }
  }
  return undefined
}
