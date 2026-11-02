import { describe, expect, it } from 'vitest'
import { userText } from '../src/recall/user-text.js'

/**
 * Extracting the turn's own words from the pre-step message batch.
 *
 * The batch is not "the user's message": it also carries context the harness
 * injected — the memory documents themselves, the skill catalog, the time
 * context. Recalling against those would score memory against memory, and the
 * best match would always be the document it was already reading.
 *
 * So this filters on `source.kind`. Hermes does the equivalent implicitly by
 * passing `original_user_message`; here the distinction has to be made by hand,
 * which is why it is its own tested seam.
 */

function msg(source: unknown, ...texts: string[]): never {
  return {
    role: 'user',
    id: 'm1',
    source,
    content: texts.map((text) => ({ type: 'text', text })),
  } as never
}

describe('userText', () => {
  it('returns the text of a plain user message', () => {
    expect(userText([msg({ kind: 'user' }, '止损怎么设')] as never)).toBe('止损怎么设')
  })

  it('joins multiple text blocks', () => {
    expect(userText([msg({ kind: 'user' }, '止损怎么设', '生益电子呢')] as never)).toBe(
      '止损怎么设 生益电子呢',
    )
  })

  it('ignores injected context and keeps only what the user wrote', () => {
    const batch = [
      msg({ kind: 'system-prompt' }, 'Saved memory for this owner: 止损 91'),
      msg({ kind: 'runtime-context' }, 'Current time: 2026-10-28'),
      msg({ kind: 'user' }, '止损怎么设'),
    ]
    // Including the injected memory here would make recall score the documents
    // against themselves, and the top hit would always be the memory block.
    expect(userText(batch as never)).toBe('止损怎么设')
  })

  it('returns empty when the batch carries no user text', () => {
    // A turn started by a scheduled task or a compact checkpoint has no user
    // message at all; recall must not invent a query from injected context.
    expect(userText([msg({ kind: 'runtime-context' }, 'now')] as never)).toBe('')
    expect(userText([] as never)).toBe('')
  })

  it('ignores non-text blocks', () => {
    const withImage = {
      role: 'user',
      id: 'm1',
      source: { kind: 'user' },
      content: [
        { type: 'image', source: { kind: 'base64', mediaType: 'image/png', data: 'x' } },
        { type: 'text', text: '这是什么' },
      ],
    }
    expect(userText([withImage] as never)).toBe('这是什么')
  })

  it('joins several user messages in order', () => {
    const batch = [msg({ kind: 'user' }, '第一句'), msg({ kind: 'user' }, '第二句')]
    expect(userText(batch as never)).toBe('第一句 第二句')
  })
})
