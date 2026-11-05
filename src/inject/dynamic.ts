import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { MemoryFiles } from '../store/files.js'
import type { MemoryTarget } from '../store/caps.js'
import { entryId } from '../store/ids.js'
import { headlineOf } from '../store/index-file.js'
import { splitEntries } from '../store/parse.js'

/**
 * 超过这个阈值后，文档就不再整份注入，而是改为注入一个指向检索工具的指针。
 *
 * 阈值之下内联严格更优：文本比一次工具往返便宜，而且规则始终在视野里。阈值之上，
 * 内联就会挤占工作上下文，于是改为告诉模型去检索。
 */
export const INLINE_BUDGET_CHARS = 6_000

/**
 * 在动态上下文中的排序位置。
 *
 * harness 的顺序是：工作目录（100）、沙箱策略（110）、审批策略（115）、子代理委派
 * （120）、团队身份（125），然后是 harness 源码（200）。记忆属于部署身份，因此紧接
 * 团队槽位之后。
 */
export const MEMORY_CONTEXT_ORDER = 130

export interface DynamicOptions {
  enabled: boolean
}

/**
 * 注册一个承载记忆文档的动态上下文。
 *
 * 这里用 `systemPrompt.context()` 而不是 `agent/pre-step`，是有意的。上下文接缝的
 * 文档定义就是「把动态的模型上下文物化为持久的 user 角色快照」，它的 `text` 提供者
 * 会在装配与准入刷新时重新求值 —— 正是记忆需要的语义。若改用 `agent/pre-step`，
 * 则要在每一步伪造一条带 ID 的 `UserMessage`，把记忆伪装成用户输入，还要替 harness
 * 签发它从未发出过的消息 ID。
 *
 * 装得进内联预算的文档整份注入；更大的则用「条目索引 + 指向 `memory_search` 的
 * 指针」表示，这样一份不断增长的记忆永远不会悄悄挤掉工作上下文。
 */
export function installDynamicInjection(
  ctx: Context,
  files: MemoryFiles,
  options: DynamicOptions,
): void {
  if (!options.enabled) return

  ctx.systemPrompt.context({
    name: 'memory:documents',
    order: MEMORY_CONTEXT_ORDER,
    text: () => {
      const memory = files.read('memory').trim()
      const user = files.read('user').trim()
      if (memory === '' && user === '') return ''

      const total = memory.length + user.length
      if (total <= INLINE_BUDGET_CHARS) {
        return renderInline(memory, user)
      }
      return renderIndex(memory, user)
    },
  })
}

export function renderInline(memory: string, user: string): string {
  const parts: string[] = [
    'Saved memory for this owner and deployment. Entries separated by § are independent rules.',
    '',
  ]
  if (memory !== '') parts.push('## Long-term memory', '', memory, '')
  if (user !== '') parts.push('## Owner profile', '', user, '')
  return parts.join('\n').trimEnd()
}

/**
 * 渲染索引：一条一行，前缀是 `memory_get` 接受的 ID。
 *
 * ID 正是这个模式的意义。一份只有被截断首行、没有 ID 的索引，会逼模型用一段它只看
 * 得到一部分的碎片去重构查询，而那是一次猜测；有了 ID，第二跳是精确的。每行多出的
 * 那十几个字符就是这一跳的价钱，而且只在这里付 —— 内联模式不需要 ID，因为每条规则
 * 都已经摆在模型面前。
 */
export function renderIndex(memory: string, user: string): string {
  const parts: string[] = [
    'Saved memory is large enough that it is summarised here.',
    'Call `memory_search` with a keyword to find entries, or `memory_get` with one of the ids below to read an entry in full.',
    '',
  ]
  for (const [title, text, target] of [
    ['Long-term memory', memory, 'memory'],
    ['Owner profile', user, 'user'],
  ] as const satisfies readonly (readonly [string, string, MemoryTarget])[]) {
    if (text === '') continue
    const entries = splitEntries(text)
    parts.push(`## ${title} (${entries.length} entries, ${text.length} chars)`, '')
    for (const entry of entries) {
      parts.push(`- ${entryId(target, entry)} · ${headlineOf(entry)}`)
    }
    parts.push('')
  }
  return parts.join('\n').trimEnd()
}
