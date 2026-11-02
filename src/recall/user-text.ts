/**
 * The shape this module needs from a pre-step message.
 *
 * Declared structurally rather than imported so the seam stays narrow: the driver
 * only ever reads `role`, `source.kind` and text blocks. A wide import would tie
 * this file to the whole `dsh-llm` message surface for the sake of three fields.
 */
interface MessageLike {
  role?: string
  source?: { kind?: string }
  content?: readonly { type?: string; text?: string }[]
}

/**
 * The words the user actually wrote this turn.
 *
 * The pre-step batch is not the user's message alone: the harness also injects
 * the memory documents, the skill catalog, the time context and the runtime
 * context as user-role messages. Recalling against those would score memory
 * against itself — the top hit would always be the document just injected — and
 * the injected block would grow with every turn.
 *
 * Text is joined with single spaces so a query split across blocks still reads as
 * one phrase to the scorer rather than as unrelated fragments.
 */
export function userText(messages: readonly MessageLike[]): string {
  const parts: string[] = []
  for (const message of messages) {
    // `role` guards against a non-user message slipping in; `source.kind` is what
    // separates the owner's own words from everything the harness adds.
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
