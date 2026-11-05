import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemoryTarget } from './caps.js'

const FILE_NAMES: Record<MemoryTarget, string> = {
  memory: 'MEMORY.md',
  user: 'USER.md',
}

const TARGETS: readonly MemoryTarget[] = ['memory', 'user']

/**
 * 两份记忆文档的持有者。
 *
 * 文本常驻内存，因为注入接缝是同步的（`systemPrompt.section({ text: fn })` 与
 * `agent/pre-step` 处理器），而读文件不是。每次写入同时更新缓存与文件，两者因此
 * 不会不一致。
 */
export class MemoryFiles {
  private readonly cache: Record<MemoryTarget, string> = { memory: '', user: '' }

  constructor(private readonly dir: string) {}

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    for (const target of TARGETS) {
      try {
        const text = await readFile(join(this.dir, FILE_NAMES[target]), 'utf8')
        this.cache[target] = text.replace(/\n+$/, '')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          this.cache[target] = ''
          continue
        }
        throw error
      }
    }
  }

  read(target: MemoryTarget): string {
    return this.cache[target]
  }

  async write(target: MemoryTarget, text: string): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    // 先落盘、再更新缓存。反过来会让一次失败的写在本进程内看起来成功：读会返回
    // 并不在磁盘上的文本，而上限检查会对着一个重启后就消失的内容通过。
    await writeFile(join(this.dir, FILE_NAMES[target]), `${text}\n`, 'utf8')
    this.cache[target] = text
  }

  path(target: MemoryTarget): string {
    return join(this.dir, FILE_NAMES[target])
  }

  directory(): string {
    return this.dir
  }
}
