import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Config } from './config.js'
import { MemoryFiles } from './store/files.js'
import { installDynamicInjection } from './inject/dynamic.js'
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

      void (async () => {
        await files.load()
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
        })
      })()

      return () => {
        disposed = true
      }
    })
  }
}
