import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertWithinCap, capReport, type MemoryTarget } from './store/caps.js'
import type { MemoryFiles } from './store/files.js'
import type { EntryIndex } from './store/index-file.js'
import { entryId, isEntryId, resolveEntry } from './store/ids.js'
import { joinEntries, splitEntries } from './store/parse.js'
import { backupMemories, rotateBackups } from './store/backup.js'
import { scoreEntries } from './inject/relevance.js'
import { FileRecall } from './recall/file-recall.js'
import { join } from 'node:path'

export interface ToolDeps {
  files: MemoryFiles
  caps: { memory: number; user: number }
  backupKeep: number
  /** 为 true 时，除检索工具外再注册 `memory_recall`。 */
  enableRecall?: boolean
  /** 单次召回的字符上限，透传给 {@link FileRecall}。 */
  recallBudgetChars?: number
  /** 条目用量统计，每次同步都从文档重建。 */
  index: EntryIndex
  /** 维护报告里判定「没用过」的标准。 */
  stale: { afterDays: number; minAgeDays: number }
}

const render = (_args: unknown, value: unknown) =>
  [{ type: 'text', text: JSON.stringify(value, null, 2) }] as never

/** 一份维护报告列出的冷条目数量。理由见调用点的注释。 */
const COLD_REPORT_LIMIT = 12

/**
 * 写入之后重新对齐用量统计并持久化。
 *
 * 每次变更后调用，而不是靠定时器：条目集合改变的时机正好就是一次写入，而一个还在
 * 描述已删规则的索引，比没有索引更糟。异常被吞掉 —— 文档写入已经成功，统计不值得
 * 让那次写入失败。
 */
async function refreshIndex(deps: ToolDeps): Promise<void> {
  try {
    deps.index.sync({ memory: deps.files.read('memory'), user: deps.files.read('user') })
    await deps.index.save()
  } catch {
    // 同上：簿记永远不能撤销一次已经落盘的写入。
  }
}

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
        await refreshIndex(deps)
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
        await refreshIndex(deps)
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
        await refreshIndex(deps)
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
                  id: { type: 'string', required: true },
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
        const matches: { target: string; id: string; entry: string; score: number }[] = []

        for (const target of ['memory', 'user'] as const) {
          const scored = scoreEntries(args.query, splitEntries(deps.files.read(target)))
          for (const candidate of scored) {
            if (candidate.score > 0) {
              matches.push({
                target,
                id: entryId(target, candidate.entry),
                entry: candidate.entry,
                score: candidate.score,
              })
            }
          }
        }

        matches.sort((a, b) => b.score - a.score)
        const total = matches.length
        // 只有被返回的匹配才算「用过」。一个给四十条打了分、只展示五条的查询，并没有
        // 用到另外三十五条；把它们也计入，会让每条记忆看起来都是热的。
        const returned = matches.slice(0, limit)
        for (const match of returned) deps.index.recordHit(match.id)
        await deps.index.save()
        return { query: args.query, matches: returned, total }
      },
    }),
  )

  ctx.tools.register(
    defineTool({
      name: 'memory_get',
      description:
        'Read one memory entry in full by id. Ids appear in the injected index and in memory_search ' +
        'results; this is the second hop when the index only showed a truncated first line.',
      parameters: {
        id: {
          type: 'string',
          required: true,
          description: 'Entry id, e.g. `m-1a2b3c4d5e`. The prefix says which document it lives in.',
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', required: true },
            id: { type: 'string', required: true },
            target: { type: 'string' },
            entry: { type: 'string' },
            chars: { type: 'number' },
            hits: { type: 'number' },
            error: { type: 'string' },
          },
        },
        render,
      },
      async execute(args) {
        const id = args.id.trim()
        if (!isEntryId(id)) {
          return { found: false, id, error: `"${id}" is not an entry id (expected m-… or u-…).` }
        }
        const resolved = resolveEntry(
          { memory: deps.files.read('memory'), user: deps.files.read('user') },
          id,
        )
        if (resolved === undefined) {
          // 未命中是常态，不是异常：模型看到的索引可能已经过了一轮，条目在此之后被
          // 压缩掉了。消息里要把这一点讲清楚，因为单独的「id 不存在」会招来重试循环。
          return {
            found: false,
            id,
            error: 'No entry with that id. It may have been replaced since the index was rendered; call memory_search.',
          }
        }
        deps.index.recordHit(id)
        await deps.index.save()
        return {
          found: true,
          id,
          target: resolved.target,
          entry: resolved.entry,
          chars: resolved.entry.length,
          hits: deps.index.byId(id)?.hits ?? 0,
        }
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
            {
              budgetChars: deps.recallBudgetChars,
              // 召回是统计能拿到的最强信号：条目是为了一个真实请求被挑中的，而不仅仅
              // 是存在于文档里。
              onHits: (hits) => {
                for (const hit of hits) deps.index.recordHit(entryId(hit.target, hit.entry))
              },
            },
          )
          const result = recall.prefetch(args.query)
          await deps.index.save()
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
        'character usage together with which entries have gone unused. Run this before a compression ' +
        'pass so the entries you merge or delete are the ones nothing has recalled.',
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
            cold: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  target: { type: 'string', required: true },
                  chars: { type: 'number', required: true },
                  headline: { type: 'string', required: true },
                  ageDays: { type: 'number', required: true },
                  hits: { type: 'number', required: true },
                },
              },
            },
            hot: {
              type: 'array',
              required: true,
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string', required: true },
                  headline: { type: 'string', required: true },
                  hits: { type: 'number', required: true },
                },
              },
            },
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

        const now = new Date()
        deps.index.sync({ memory: deps.files.read('memory'), user: deps.files.read('user') }, now)
        await deps.index.save()

        // 这份报告是阅读辅助，不是审计：十二条冷条目已经超过一次压缩能处理的量，而全量
        // 清单会挤掉那些让报告可读的用量数字。
        const cold = deps.index.cold(deps.stale, now).slice(0, COLD_REPORT_LIMIT).map((record) => ({
          id: record.id,
          target: record.target,
          chars: record.chars,
          headline: record.headline,
          ageDays: Math.floor((now.getTime() - Date.parse(record.lastHitAt ?? record.firstSeenAt)) / 86_400_000),
          hits: record.hits,
        }))
        const hot = deps.index.hot(5).map((record) => ({
          id: record.id,
          headline: record.headline,
          hits: record.hits,
        }))

        return {
          ok: true,
          backupDir,
          memory,
          user,
          cold,
          hot,
          hint: over
            ? `Over cap. Compress with memory_replace; ${cold.length > 0 ? 'the cold entries below are the ones nothing has recalled.' : 'no entry is cold yet, so merge by meaning.'}`
            : cold.length > 0
              ? `Within cap. ${cold.length} entr${cold.length === 1 ? 'y has' : 'ies have'} gone unused — review them before adding more.`
              : 'Within cap, and no entry has gone unused. No compression needed.',
        }
      },
    }),
  )
}
