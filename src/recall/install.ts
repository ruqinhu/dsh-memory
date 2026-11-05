import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AutoRecall, type AutoRecallDeps } from './auto-recall.js'
import { userText } from './user-text.js'

/**
 * 每回合召回一次，在第一步执行，并把结果追加进这一步的批次。
 *
 * 位置是有讲究的。另一种做法是 `systemPrompt.context()` —— 文档注入用的就是它 ——
 * 但在这里是错的：动态上下文会在每次准入刷新时重新装配，放那里的召回会对整个会话
 * 反复注入，而不是每回合一次，并且会随文档在会话中途变化而漂移。
 *
 * 限定 `step === 1` 是「每回合一次」的另一半。`agent/pre-step` 在每个步骤边界都会
 * 触发，没有这道判断的话，每次工具调用前都会再追加一遍同样的块，回合上下文会随着
 * 自身长度一起增长。
 */
export function installAutoRecall(
  ctx: Context,
  deps: Omit<AutoRecallDeps, 'recall'> & {
    recall: (query: string) => { block: string; indicator: string }
  },
): void {
  const driver = new AutoRecall(deps as AutoRecallDeps)

  ctx.effect(() => {
    const dispose = ctx.on('agent/pre-step', async (payload, next) => {
      const decision = await next()

      // 被取消的回合永远不召回：下一条消息几乎肯定是同一意图的重试，而一段以被放弃
      // 文本为键的召回块，会被挂到一个不同的问题上。
      if (decision.kind === 'reject') return decision
      if (payload.signal.aborted) return decision
      if (payload.step !== 1) return decision

      const block = driver.prefetch(userText(payload.messages))
      if (block === '') return decision

      const recalled: UserMessage = createUserMessage({
        content: [{ type: 'text', text: block }],
        // `system-prompt` 是 harness 给自己注入上下文时用的 kind，`instructions`
        // 这个 form 告诉消费方这是什么。标成 `user` 等于每次回放会话都在替 owner
        // 说话，还会制造一条读起来像是他亲手输入的消息。
        source: { kind: 'system-prompt', form: 'instructions' },
      })
      return { ...decision, messages: [...decision.messages, recalled] }
    })
    return () => void dispose()
  })
}
