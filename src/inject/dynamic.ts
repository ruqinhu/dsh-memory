import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { MemoryFiles } from '../store/files.js'
import { splitEntries } from '../store/parse.js'

/**
 * Threshold past which a document is injected as a pointer to the retrieval tool
 * instead of in full.
 *
 * Below it, inlining is strictly better: the text is cheaper than a tool round
 * trip and the model always has the rules in view. Above it, inlining would
 * crowd out working context, so the model is told to search instead.
 */
export const INLINE_BUDGET_CHARS = 6_000

/**
 * Placement among dynamic contexts.
 *
 * The harness orders contexts as working directory (100), sandbox policy (110),
 * approval policy (115), subagent delegation (120), team identity (125), then
 * harness source (200). Memory is deployment identity, so it sits just after the
 * team slot.
 */
export const MEMORY_CONTEXT_ORDER = 130

export interface DynamicOptions {
  enabled: boolean
}

/**
 * Register a dynamic context carrying the memory documents.
 *
 * This uses `systemPrompt.context()` rather than `agent/pre-step` on purpose.
 * The context seam is documented as "dynamic model context materialized as a
 * durable user-role snapshot", and its `text` provider is re-evaluated at
 * assembly and admission refresh — exactly the semantics memory needs. Injecting
 * through `agent/pre-step` would instead require fabricating an identified
 * `UserMessage` on every step, which misrepresents memory as user input and makes
 * the plugin mint message ids the harness never issued.
 *
 * Documents that fit the inline budget are injected whole; larger ones are
 * represented by an entry index plus a pointer to `memory_search`, so a growing
 * memory never silently displaces working context.
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

function renderInline(memory: string, user: string): string {
  const parts: string[] = [
    'Saved memory for this owner and deployment. Entries separated by § are independent rules.',
    '',
  ]
  if (memory !== '') parts.push('## Long-term memory', '', memory, '')
  if (user !== '') parts.push('## Owner profile', '', user, '')
  return parts.join('\n').trimEnd()
}

function renderIndex(memory: string, user: string): string {
  const parts: string[] = [
    'Saved memory is large enough that it is summarised here.',
    'Call `memory_search` with a keyword to read the entries you need; call `memory_read` for a document in full.',
    '',
  ]
  for (const [title, text] of [
    ['Long-term memory', memory],
    ['Owner profile', user],
  ] as const) {
    if (text === '') continue
    const entries = splitEntries(text)
    parts.push(`## ${title} (${entries.length} entries, ${text.length} chars)`, '')
    for (const entry of entries) {
      const headline = entry.split('\n')[0] ?? entry
      parts.push(`- ${headline.slice(0, 80)}`)
    }
    parts.push('')
  }
  return parts.join('\n').trimEnd()
}
