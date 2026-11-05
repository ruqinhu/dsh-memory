import { copyFile, mkdir, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

const BACKED_UP = ['MEMORY.md', 'USER.md'] as const

/** 备份时间戳按操作者本地日而非 UTC 计算的偏移量。 */
const LOCAL_OFFSET_MS = 8 * 3_600_000

/**
 * `+08:00` 下的 `YYYYMMDD_HHMMSS`。
 *
 * 本地偏移是显式加上的：否则一个周六 01:30（+08:00）的压缩任务会被盖上前一天的
 * UTC 日期，让轮转顺序和人的阅读都产生误解。
 */
export function stamp(date: Date): string {
  const shifted = new Date(date.getTime() + LOCAL_OFFSET_MS)
  return shifted.toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_')
}

/** 把记忆文档复制进 `backups/<stamp>/` 并返回该目录。 */
export async function backupMemories(memoryDir: string, at: Date): Promise<string> {
  const dest = join(memoryDir, 'backups', stamp(at))
  await mkdir(dest, { recursive: true })
  for (const name of BACKED_UP) {
    try {
      await copyFile(join(memoryDir, name), join(dest, name))
    } catch (error) {
      // 全新部署上文档缺失是正常的，存在什么就备份什么。
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
  }
  return dest
}

/** 只保留最新的 `keep` 个备份目录。 */
export async function rotateBackups(root: string, keep: number): Promise<void> {
  let names: string[]
  try {
    names = await readdir(root)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  const sorted = names.sort().reverse()
  for (const stale of sorted.slice(Math.max(0, keep))) {
    await rm(join(root, stale), { recursive: true, force: true })
  }
}
