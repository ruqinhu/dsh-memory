import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MemoryTarget } from './caps.js'

const FILE_NAMES: Record<MemoryTarget, string> = {
  memory: 'MEMORY.md',
  user: 'USER.md',
}

const TARGETS: readonly MemoryTarget[] = ['memory', 'user']

/**
 * Owns the two memory documents.
 *
 * Text is kept in memory because the injection seams are synchronous
 * (`systemPrompt.section({ text: fn })` and the `agent/pre-step` handler) while
 * file reads are not. Every write updates the cache and the file together, so
 * the two never disagree.
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
    // Persist before updating the cache. Updating first would make a failed write
    // invisible for the rest of the process: reads would return text that is not
    // on disk, and a cap check would pass against content that vanished on
    // restart.
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
