import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertWithinCap, capReport, type MemoryTarget } from './store/caps.js'
import type { MemoryFiles } from './store/files.js'
import { joinEntries, splitEntries } from './store/parse.js'
import { backupMemories, rotateBackups } from './store/backup.js'
import { scoreEntries } from './inject/relevance.js'
import { FileRecall } from './recall/file-recall.js'
import { join } from 'node:path'

export interface ToolDeps {
  files: MemoryFiles
  caps: { memory: number; user: number }
  backupKeep: number
  /** When true, register `memory_recall` alongside the search tool. */
  enableRecall?: boolean
  /** Character ceiling for one recall, threaded through to {@link FileRecall}. */
  recallBudgetChars?: number
}

const render = (_args: unknown, value: unknown) =>
  [{ type: 'text', text: JSON.stringify(value, null, 2) }] as never

const TARGET_PARAM = {
  type: 'string',
  required: true,
  enum: ['memory', 'user'],
  description: 'memory = durable facts and rules; user = owner profile',
} as const

const CAP_FIELDS = {
  current: { type: 'number', required: true },
  cap: { type: 'number', required: true },
  percent: { type: 'number', required: true },
  over: { type: 'boolean', required: true },
} as const

export function registerTools(ctx: Context, deps: ToolDeps): void {
  const capFor = (target: MemoryTarget): number => deps.caps[target]

  ctx.tools.register(
    defineTool({
      name: 'memory_read',
      description:
        'Read the long-term memory document or the owner profile, with current character usage and entry count.',
      parameters: { target: TARGET_PARAM },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            target: { type: 'string', required: true },
            text: { type: 'string', required: true },
            entries: { type: 'number', required: true },
            ...CAP_FIELDS,
          },
        },
        render,
      },
      async execute(args) {
        const target = args.target as MemoryTarget
        const text = deps.files.read(target)
        return { target, text, entries: splitEntries(text).length, ...capReport(text, capFor(target)) }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'memory_write',
      description:
        'Replace an entire memory document. Rejected when the result exceeds the character cap — ' +
        'compress the entries first instead of truncating, because truncation silently drops rules.',
      parameters: {
        target: TARGET_PARAM,
        content: {
          type: 'string',
          required: true,
          description: 'Full replacement text. Entries may be separated by §.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            current: { type: 'number' },
            cap: { type: 'number' },
            entries: { type: 'number' },
            error: { type: 'string' },
          },
        },
        render,
      },
      async execute(args) {
        const target = args.target as MemoryTarget
        const cap = capFor(target)
        try {
          assertWithinCap(target, args.content, cap)
        } catch (error) {
          return { ok: false, current: args.content.length, cap, error: (error as Error).message }
        }
        await deps.files.write(target, args.content)
        return { ok: true, current: args.content.length, cap, entries: splitEntries(args.content).length }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'memory_append',
      description:
        'Append one §-delimited entry to a memory document. Rejected when the result would exceed the cap.',
      parameters: {
        target: TARGET_PARAM,
        entry: { type: 'string', required: true, description: 'One dense rule or fact.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            current: { type: 'number' },
            cap: { type: 'number' },
            entries: { type: 'number' },
            error: { type: 'string' },
          },
        },
        render,
      },
      async execute(args) {
        const target = args.target as MemoryTarget
        const cap = capFor(target)
        const existing = splitEntries(deps.files.read(target))
        const next = joinEntries([...existing, args.entry])
        try {
          assertWithinCap(target, next, cap)
        } catch (error) {
          return { ok: false, current: next.length, cap, entries: existing.length, error: (error as Error).message }
        }
        await deps.files.write(target, next)
        return { ok: true, current: next.length, cap, entries: existing.length + 1 }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'memory_replace',
      description:
        'Replace an exact substring inside a memory document. Use during compression to rewrite a ' +
        'stale rule in place; passing an empty replacement deletes the match.',
      parameters: {
        target: TARGET_PARAM,
        find: { type: 'string', required: true, description: 'Exact substring to locate.' },
        replace: {
          type: 'string',
          required: true,
          description: 'Replacement text. Empty string deletes the match.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            replaced: { type: 'number', required: true },
            current: { type: 'number' },
            cap: { type: 'number' },
            error: { type: 'string' },
          },
        },
        render,
      },
      async execute(args) {
        const target = args.target as MemoryTarget
        const cap = capFor(target)
        const before = deps.files.read(target)
        const occurrences = before.split(args.find).length - 1

        if (occurrences === 0) {
          return { ok: false, replaced: 0, current: before.length, cap, error: `"${args.find}" not found in ${target} memory` }
        }

        const normalized = joinEntries(splitEntries(before.split(args.find).join(args.replace)))
        try {
          assertWithinCap(target, normalized, cap)
        } catch (error) {
          return { ok: false, replaced: 0, current: normalized.length, cap, error: (error as Error).message }
        }
        await deps.files.write(target, normalized)
        return { ok: true, replaced: occurrences, current: normalized.length, cap }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'memory_search',
      description:
        'Keyword-search the memory entries and return the matching ones. Use this when the injected ' +
        'memory summary is too large or when you need the full text of a rule.',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Keywords to match. CJK phrases and ASCII words both work.',
        },
        limit: { type: 'number', description: 'Maximum entries to return. Defaults to 5.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            query: { type: 'string', required: true },
            matches: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  target: { type: 'string', required: true },
                  entry: { type: 'string', required: true },
                  score: { type: 'number', required: true },
                },
              },
            },
            total: { type: 'number', required: true },
          },
        },
        render,
      },
      async execute(args) {
        const limit = args.limit === undefined ? 5 : Math.max(1, Math.floor(args.limit))
        const matches: { target: string; entry: string; score: number }[] = []

        for (const target of ['memory', 'user'] as const) {
          const scored = scoreEntries(args.query, splitEntries(deps.files.read(target)))
          for (const candidate of scored) {
            if (candidate.score > 0) matches.push({ target, entry: candidate.entry, score: candidate.score })
          }
        }

        matches.sort((a, b) => b.score - a.score)
        const total = matches.length
        return { query: args.query, matches: matches.slice(0, limit), total }
      },
    }),
  )

  if (deps.enableRecall === true) {
    ctx.tools.register(
      defineTool({
        name: 'memory_recall',
        description:
          'Recall the saved memory entries relevant to a request, as a ready-to-use context block. ' +
          'Use this before answering when the injected memory was summarised as an index rather than ' +
          'shown in full. Unlike memory_search, the result is already rendered for reading: it groups ' +
          'rules separately from owner preferences and reports how many entries it surfaced.',
        parameters: {
          query: {
            type: 'string',
            required: true,
            description: 'The request or topic to recall memory for. CJK and ASCII both work.',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              query: { type: 'string', required: true },
              block: { type: 'string', required: true },
              indicator: { type: 'string', required: true },
              count: { type: 'number', required: true },
            },
          },
          render,
        },
        async execute(args) {
          const recall = new FileRecall(
            { memory: deps.files.read('memory'), user: deps.files.read('user') },
            { budgetChars: deps.recallBudgetChars },
          )
          const result = recall.prefetch(args.query)
          return {
            query: args.query,
            block: result.block,
            indicator: result.indicator,
            count: result.indicator === '' ? 0 : Number(/(\d+)/.exec(result.indicator)?.[1] ?? 0),
          }
        },
      }),
    )
  }

  ctx.tools.register(
    defineTool({
      name: 'memory_maintenance',
      description:
        'Back up both memory documents into a timestamped directory, rotate old backups, and report ' +
        'character usage. Run this before a compression pass.',
      parameters: {
        backup: { type: 'boolean', description: 'Take a backup first. Defaults to true.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            backupDir: { type: 'string' },
            memory: { type: 'object', additionalProperties: false, properties: CAP_FIELDS },
            user: { type: 'object', additionalProperties: false, properties: CAP_FIELDS },
            hint: { type: 'string' },
          },
        },
        render,
      },
      async execute(args) {
        const shouldBackup = args.backup ?? true
        let backupDir = ''
        if (shouldBackup) {
          backupDir = await backupMemories(deps.files.directory(), new Date())
          await rotateBackups(join(deps.files.directory(), 'backups'), deps.backupKeep)
        }

        const memory = capReport(deps.files.read('memory'), deps.caps.memory)
        const user = capReport(deps.files.read('user'), deps.caps.user)
        const over = memory.over || user.over

        return {
          ok: true,
          backupDir,
          memory,
          user,
          hint: over
            ? 'Over cap. Merge or drop stale entries with memory_replace, then re-check.'
            : 'Within cap. No compression needed unless entries have gone stale.',
        }
      },
    }),
  )
}
