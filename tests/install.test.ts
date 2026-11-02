import { describe, expect, it } from 'vitest'
import { installAutoRecall } from '../src/recall/install.js'
import type { RecallResult } from '../src/recall/file-recall.js'

/**
 * The wiring between the pre-step seam and `AutoRecall`.
 *
 * Tested against a fake context rather than the real one because what matters
 * here is the contract with the harness, not the harness itself: that the
 * listener passes the decision through untouched when it has nothing to add,
 * and that a failure inside recall cannot reject the step.
 *
 * The pass-through is the load-bearing part. `agent/pre-step` is a waterfall:
 * returning a replaced decision means this plugin now owns what the model sees,
 * and a bug there would silently drop the user's own message from the turn.
 */

interface FakeCtx {
  handlers: Map<string, (payload: unknown, next: () => Promise<unknown>) => Promise<unknown>>
  on(event: string, handler: never): () => void
  effect(fn: () => (() => void) | void): () => void
}

function fakeCtx(): FakeCtx {
  const handlers = new Map<string, (p: unknown, n: () => Promise<unknown>) => Promise<unknown>>()
  return {
    handlers,
    on(event, handler) {
      handlers.set(event, handler)
      return () => handlers.delete(event)
    },
    // Mirrors the real seam: the callback runs immediately and its disposer is
    // held by the caller's fiber, so a test that only registers handlers is
    // exercising the same path the harness does.
    effect(fn) {
      return fn() ?? (() => {})
    },
  }
}

const DECISION = { kind: 'enter', messages: [{ role: 'user', id: 'u1' }] }

function payload(texts: string[], injected: string[], step = 1) {
  const content = (text: string) => [{ type: 'text', text }]
  return {
    messages: [
      ...injected.map((t) => ({ role: 'user', source: { kind: 'system-prompt' }, content: content(t) })),
      ...texts.map((t) => ({ role: 'user', source: { kind: 'user' }, content: content(t) })),
    ],
    turn: 1,
    step,
    signal: { aborted: false },
  }
}

function setup(result: RecallResult | (() => RecallResult)) {
  const ctx = fakeCtx()
  const reported: string[] = []
  installAutoRecall(ctx as never, {
    enabled: true,
    recall: typeof result === 'function' ? result : () => result,
    report: (line) => reported.push(line),
  })
  const handler = ctx.handlers.get('agent/pre-step')
  if (handler === undefined) throw new Error('no agent/pre-step listener registered')
  return { run: (p: unknown) => handler(p, async () => DECISION), reported }
}

const HIT: RecallResult = { block: 'Recalled:\n- 止损 91', indicator: '🧠 召回 1 条记忆' }

describe('installAutoRecall', () => {
  it('registers on agent/pre-step', () => {
    const { run } = setup(HIT)
    expect(run).toBeTypeOf('function')
  })

  it('passes the decision through untouched when nothing is recalled', async () => {
    const { run } = setup({ block: '', indicator: '' })
    const out = await run(payload(['止损怎么设'], []))
    // Identity, not deep-equality: replacing the object at all takes ownership of
    // the turn's message batch, which is how a bug here silently drops the user's
    // own message.
    expect(out).toBe(DECISION)
  })

  it('does not inject when the decision is a reject', async () => {
    const ctx = fakeCtx()
    installAutoRecall(ctx as never, { enabled: true, recall: () => HIT, report: () => {} })
    const handler = ctx.handlers.get('agent/pre-step')!
    const out = (await handler(payload(['止损怎么设'], []), async () => ({ kind: 'reject' }))) as {
      kind: string
    }
    expect(out.kind).toBe('reject')
  })

  it('does not inject on later steps of the same turn', async () => {
    // Recall is a per-turn decision. Injecting again on step 2 adds a second copy
    // of the same memory mid-turn and inflates the context as the turn goes on.
    const { run } = setup(HIT)
    const out = await run(payload(['止损怎么设'], [], 2))
    expect(out).toBe(DECISION)
  })

  it('survives a throwing recall', async () => {
    const { run } = setup(() => {
      throw new Error('boom')
    })
    const out = await run(payload(['止损怎么设'], []))
    expect(out).toBe(DECISION)
  })

  it('ignores injected context when building the query', async () => {
    let seen = ''
    const { run } = setup(() => {
      return { block: '', indicator: '' }
    })
    const ctx = fakeCtx()
    installAutoRecall(ctx as never, {
      enabled: true,
      recall: (q) => {
        seen = q
        return { block: '', indicator: '' }
      },
      report: () => {},
    })
    await ctx.handlers.get('agent/pre-step')!(payload(['止损怎么设'], ['止损 91 已记住']), async () => DECISION)
    expect(seen).toBe('止损怎么设')
  })
})
