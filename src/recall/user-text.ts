/**
 * 本模块从 pre-step 消息里需要的字段形状。
 *
 * 用结构化声明而不是直接 import，是为了让接缝保持狭窄：驱动只读 `role`、
 * `source.kind` 和文本块。为了三个字段去引入整个 `dsh-llm` 消息面，会把本文件
 * 和它绑死。
 */
interface MessageLike {
  role?: string
  source?: { kind?: string }
  content?: readonly { type?: string; text?: string }[]
}

/**
 * 本回合里用户真正写下的字。
 *
 * pre-step 的批次不只有用户消息：harness 还会把记忆文档、技能目录、时间上下文和
 * 运行时上下文都以 user 角色注入。拿这些去召回，等于让记忆和自己比对 —— 最高分的
 * 永远是刚注入的那份文档 —— 而且注入块会随每回合越滚越大。
 *
 * 文本之间用单个空格连接，这样一个被拆到多个块里的查询仍然读作一句话，而不是几段
 * 互不相干的碎片。
 */
export function userText(messages: readonly MessageLike[]): string {
  const parts: string[] = []
  for (const message of messages) {
    // `role` 挡住混进来的非用户消息；`source.kind` 才是把 owner 自己的话和 harness
    // 添加的一切分开的那个字段。
    if (message.role !== 'user') continue
    if (message.source?.kind !== 'user') continue
    for (const block of message.content ?? []) {
      if (block.type !== 'text') continue
      const text = block.text?.trim() ?? ''
      if (text !== '') parts.push(text)
    }
  }
  return parts.join(' ')
}
