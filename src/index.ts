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
    // 用 `memoryStore` 而不是 `memory`：后者这个名字太通用，将来一个官方服务完全
    // 可能占用它并造成冲突。
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
        // 在做任何读取之前先把按条目的统计播种好。这也是给「侧车出现之前就已存在」
        // 的条目盖 firstSeenAt 的地方，否则第一份冷报告会把整份文档都当成新条目。
        index.sync({ memory: files.read('memory'), user: files.read('user') })
        await index.save().catch(() => undefined)
        // 加载过程中 fiber 可能已经被拆掉；那之后再去注册接缝，它们会活过销毁。
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

        // 每回合自动召回与 `memory_recall` 工具读同一批文档、走同一份实现，所以两者
        // 不可能给出不同答案。召回对象按调用重建而不是缓存：只要有人写工具，文档就会
        // 在它脚下变化，缓存视图会召回刚被删掉的条目。
        if (config.enableAutoRecall) {
          installAutoRecall(this.ctx, {
            enabled: true,
            recall: (query) =>
              new FileRecall(
                { memory: files.read('memory'), user: files.read('user') },
                {
                  budgetChars: config.recallBudgetChars,
                  // 每回合都触发的自动召回，是本插件最丰富的用量证据来源，而它所属的
                  // 那个回合自己从不调用召回工具。
                  onHits: (hits) => {
                    for (const hit of hits) index.recordHit(entryId(hit.target, hit.entry))
                    // 做了合并：这每回合都会触发，而几个计数器不值得每次都写侧车。
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
