import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { AutoRecall, type AutoRecallDeps } from './auto-recall.js'
import { userText } from './user-text.js'

/**
 * Recall once per turn, at the first step, and append the result to the batch.
 *
 * Placement is deliberate. The alternative — `systemPrompt.context()` — is what
 * the document injection already uses, and it is wrong here: a dynamic context is
 * reassembled on every admission refresh, so a recall there would re-inject for
 * the whole session rather than once for the turn, and would drift as the
 * document changed mid-session.
 *
 * Restricting to `step === 1` is the other half of "once per turn". `agent/pre-step`
 * fires at every step boundary, so without the guard the same block is appended
 * again before each tool call and the turn's context grows with its own length.
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

      // Cancelled turns never get a recall: the next message is almost certainly
      // a retry of the same intent, and a block keyed on the abandoned text would
      // arrive attached to a different question.
      if (decision.kind === 'reject') return decision
      if (payload.signal.aborted) return decision
      if (payload.step !== 1) return decision

      const block = driver.prefetch(userText(payload.messages))
      if (block === '') return decision

      const recalled: UserMessage = createUserMessage({
        content: [{ type: 'text', text: block }],
        // `system-prompt` is the kind the harness already uses for context it
        // injects, and the `instructions` form tells the consumer what this is.
        // Claiming `user` would put words in the owner's mouth on every replay of
        // the session, and mint a message that reads as something they typed.
        source: { kind: 'system-prompt', form: 'instructions' },
      })
      return { ...decision, messages: [...decision.messages, recalled] }
    })
    return () => void dispose()
  })
}
