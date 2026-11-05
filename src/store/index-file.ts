import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { MemoryTarget } from './caps.js'
import { entryId } from './ids.js'
import { splitEntries } from './parse.js'

/**
 * 按条目记录的用量统计，作为侧车文件存放在文档旁边。
 *
 * 记忆文档说明规则是什么，却说不出哪一条配得上它占的字符。而这正是压缩的全部难点 ——
 * 上限逼着必须删掉点什么，没有证据时选择就会退化成「我碰巧又读到哪条」，一条仍然有效
 * 的规则就这样被删掉，而一条死规则又活了一年。
 *
 * 所以每次召回、检索和显式读取都记一次命中，维护报告于是能点名那些几周都没匹配上任何
 * 东西的条目。证据是下界：一条每次请求都被整份内联注入的条目，一直在被使用却永远不会
 * 被「命中」，所以冷条目只是复核候选，永远不会被自动删除。
 */
export interface EntryRecord {
  id: string
  target: MemoryTarget
  chars: number
  /** 首行、截断：索引显示的是它，人在报告里扫的也是它。 */
  headline: string
  firstSeenAt: string
  lastHitAt?: string
  hits: number
}

interface IndexData {
  version: 1
  entries: EntryRecord[]
}

/** 侧车文件名。点号开头，这样它永远不会被读成两份文档之一。 */
export const INDEX_FILE = '.entry-index.json'

const HEADLINE_CHARS = 80

/** 首行、截断。与索引渲染共用，两者因此不会漂移。 */
export function headlineOf(entry: string, maxChars: number = HEADLINE_CHARS): string {
  const firstLine = entry.split('\n')[0] ?? entry
  return firstLine.length > maxChars ? `${firstLine.slice(0, maxChars)}…` : firstLine
}

const TARGETS: readonly MemoryTarget[] = ['memory', 'user']

export interface Documents {
  memory: string
  user: string
}

export interface ColdOptions {
  /** 这么久没有命中的条目即为冷条目。 */
  afterDays: number
  /**
   * 年轻于此天数的条目永不报告。
   *
   * 昨天刚写的规则只有一天的被用机会；说它「没用」更多反映的是它什么时候被写下的，
   * 而不是它重不重要。而一份全是新条目的报告，会训练读者忽略这份报告。
   */
  minAgeDays: number
}

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * 面向 {@link EntryRecord} 的读改写存储，与文档保持对齐。
 *
 * 有意不做文档本身的缓存：`sync` 拿文档当前文本做对账，于是侧车永远不可能和
 * `MEMORY.md` 不一致 —— 不在正文里的 ID 会在下一次同步时被丢掉，而新条目以零命中
 * 出现。
 */
export class EntryIndex {
  private records = new Map<string, EntryRecord>()
  private dirty = false
  private lastSavedAt = 0

  constructor(private readonly path: string) {}

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<IndexData>
      if (parsed.version !== 1 || !Array.isArray(parsed.entries)) return
      for (const record of parsed.entries) {
        if (!isRecord(record)) continue
        this.records.set(record.id, record)
      }
    } catch {
      // 侧车不存在是正常的首次运行。损坏的侧车比没用更糟 —— 它会让已经不存在的条目
      // 的统计复活 —— 但也不值得让插件失败：文档才是真相，下一次 sync 会从文档重建
      // 每一个 ID。
      this.records.clear()
    }
  }

  /**
   * 让记录与当前文档对齐，并返回结果。
   *
   * 删除是隐式的：映射是按文档现在包含的内容重建的，所以被删掉的条目连同统计一起
   * 消失。被改写的条目哈希不同，因此从零命中开始 —— 这是诚实的回答，之前被读过的
   * 那条规则，已经不是现在存在的这条规则了。
   */
  sync(documents: Documents, now: Date = new Date()): EntryRecord[] {
    const next = new Map<string, EntryRecord>()

    for (const target of TARGETS) {
      for (const entry of splitEntries(documents[target])) {
        const id = entryId(target, entry)
        const previous = this.records.get(id)
        next.set(id, {
          id,
          target,
          chars: entry.length,
          headline: headlineOf(entry),
          firstSeenAt: previous?.firstSeenAt ?? now.toISOString(),
          ...(previous?.lastHitAt === undefined ? {} : { lastHitAt: previous.lastHitAt }),
          hits: previous?.hits ?? 0,
        })
      }
    }

    if (!sameRecords(this.records, next)) this.dirty = true
    this.records = next
    return this.snapshot()
  }

  /**
   * 记一次条目使用。
   *
   * 未知 ID 会被忽略而不是新建：对一条已不在文档里的条目记命中，是上一轮留下的过期
   * 引用，为它凭空造一条记录会让下一次 `cold` 报告列出幽灵。
   */
  recordHit(id: string, now: Date = new Date()): void {
    const record = this.records.get(id)
    if (record === undefined) return
    record.hits += 1
    record.lastHitAt = now.toISOString()
    this.dirty = true
  }

  /**
   * 最近没被用过的条目，最大的排前面。
   *
   * 按大小降序，是因为这份报告要回答「该砍什么」，而最大的一条冷条目就是每次删除
   * 换来的最大压缩量。
   */
  cold(options: ColdOptions, now: Date = new Date()): EntryRecord[] {
    const afterMs = options.afterDays * DAY_MS
    const minAgeMs = options.minAgeDays * DAY_MS
    const nowMs = now.getTime()

    const out: EntryRecord[] = []
    for (const record of this.records.values()) {
      const firstSeen = Date.parse(record.firstSeenAt)
      const lastUsed = record.lastHitAt === undefined ? firstSeen : Date.parse(record.lastHitAt)
      if (!Number.isFinite(firstSeen) || !Number.isFinite(lastUsed)) continue
      if (nowMs - lastUsed < afterMs) continue
      if (nowMs - firstSeen < minAgeMs) continue
      out.push(record)
    }
    return out.sort((a, b) => b.chars - a.chars)
  }

  /** 用得最多的条目，维护报告的另一半。 */
  hot(limit: number): EntryRecord[] {
    return [...this.records.values()]
      .filter((record) => record.hits > 0)
      .sort((a, b) => b.hits - a.hits)
      .slice(0, limit)
  }

  byId(id: string): EntryRecord | undefined {
    return this.records.get(id)
  }

  snapshot(): EntryRecord[] {
    return [...this.records.values()]
  }

  /**
   * 持久化侧车。
   *
   * 先写临时文件再 rename，这样写到一半被杀也不会留下截断的文件：`load` 把坏 JSON
   * 当成「从头开始」，于是一次不完整的写会悄悄重置所有统计。失败由调用方记录日志 ——
   * 统计是便利，永远不是让一次已经落盘的记忆写入失败的理由。
   */
  async save(): Promise<void> {
    if (!this.dirty) return
    const data: IndexData = { version: 1, entries: this.snapshot() }
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.tmp`
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    await rename(temp, this.path)
    this.dirty = false
    this.lastSavedAt = Date.now()
  }

  /**
   * 只在有变化、且距上次写入超过 `minIntervalMs` 时持久化。
   *
   * 自动召回每触发一次就记一次命中。每次都存，等于为了几个计数器增量每回合重写一次
   * 侧车；从不存，则每一条被自动召回的条目在下一次维护时都会被看成冷条目。一分钟的
   * 合并窗口让这两件事都不会发生。
   */
  async saveIfIdleSince(minIntervalMs: number, now: number = Date.now()): Promise<void> {
    if (!this.dirty) return
    if (now - this.lastSavedAt < minIntervalMs) return
    await this.save()
  }
}

function isRecord(value: unknown): value is EntryRecord {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Partial<EntryRecord>
  return (
    typeof candidate.id === 'string' &&
    (candidate.target === 'memory' || candidate.target === 'user') &&
    typeof candidate.chars === 'number' &&
    typeof candidate.headline === 'string' &&
    typeof candidate.firstSeenAt === 'string' &&
    typeof candidate.hits === 'number'
  )
}

/**
 * 两套记录是否有读者能看见的差异。
 *
 * 命中数与时间戳也要比：一次只捞到一个命中的 sync 同样需要落盘，否则计数器会在重启
 * 后归零。
 */
function sameRecords(before: Map<string, EntryRecord>, after: Map<string, EntryRecord>): boolean {
  if (before.size !== after.size) return false
  for (const [id, record] of after) {
    const previous = before.get(id)
    if (previous === undefined) return false
    if (
      previous.chars !== record.chars ||
      previous.headline !== record.headline ||
      previous.hits !== record.hits ||
      previous.firstSeenAt !== record.firstSeenAt ||
      previous.lastHitAt !== record.lastHitAt
    ) {
      return false
    }
  }
  return true
}

/** 某个记忆目录的默认侧车路径。 */
export function indexPathFor(memoryDir: string): string {
  return join(memoryDir, INDEX_FILE)
}
