import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config } from './config.js'
import { MemoryFiles } from './store/files.js'
import { EntryIndex, indexPathFor } from './store/index-file.js'
import { entryId } from './store/ids.js'
import { installDynamicInjection } from './inject/dynamic.js'
import { FileRecall } from './recall/file-recall.js'
import { installAutoRecall } from './recall/install.js'
import { installCurationSkill } from './skill.js'
import { registerTools } from './tools.js'

export const name = 'memory'

export function expandTilde(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

export default class Memory extends Service {
  static inject = ['tools', 'systemPrompt']
  static Config = Config

  private readonly memoryDir: string
  private readonly caps: { memory: number; user: number }

  constructor(ctx: Context, public config: Config) {
    // Prefixed rather than `memory`: that name is generic enough that a future
    // official service could claim it and collide.
    super(ctx, 'memoryStore')
    this.memoryDir = expandTilde(config.memoryDir)
    this.caps = { memory: config.memoryCap, user: config.userCap }

    ctx.effect(() => {
      let disposed = false
      const files = new MemoryFiles(this.memoryDir)
      const index = new EntryIndex(indexPathFor(this.memoryDir))

      void (async () => {
        await files.load()
        await index.load()
        // Seed the per-entry statistics before anything can read them. This is also
        // what stamps `firstSeenAt` for entries written before the sidecar existed,
        // so the first cold-entry report does not treat the whole document as new.
        index.sync({ memory: files.read('memory'), user: files.read('user') })
        await index.save().catch(() => undefined)
        // The fiber may have been torn down while the files were loading;
        // registering seams after that would leak them past disposal.
        if (disposed) return

        installDynamicInjection(this.ctx, files, { enabled: config.enableInjection })
        registerTools(this.ctx, {
          files,
          caps: this.caps,
          backupKeep: config.backupKeep,
          enableRecall: config.enableRecall,
          recallBudgetChars: config.recallBudgetChars,
          index,
          stale: { afterDays: config.staleAfterDays, minAgeDays: config.staleMinAgeDays },
        })
        if (config.enableSkill) installCurationSkill(this.ctx)

        // Automatic per-turn recall reads the same documents through the same
        // implementation the `memory_recall` tool uses, so the two cannot answer
        // differently. The recall object is rebuilt per call rather than cached:
        // the documents change under it whenever a tool writes, and a cached view
        // would recall entries that were just deleted.
        if (config.enableAutoRecall) {
          installAutoRecall(this.ctx, {
            enabled: true,
            recall: (query) =>
              new FileRecall(
                { memory: files.read('memory'), user: files.read('user') },
                {
                  budgetChars: config.recallBudgetChars,
                  // An automatic recall that fires on every turn is the richest
                  // source of usage evidence this plugin has, and the turn it
                  // belongs to never calls the recall tool itself.
                  onHits: (hits) => {
                    for (const hit of hits) index.recordHit(entryId(hit.target, hit.entry))
                    // Coalesced: this fires every turn, and the counters are not
                    // worth a sidecar write each time.
                    void index.saveIfIdleSince(60_000).catch(() => undefined)
                  },
                },
              ).prefetch(query),
            report: (line) => {
              this.ctx.logger?.info?.(line)
            },
          })
        }
      })()

      return () => {
        disposed = true
      }
    })
  }
}
