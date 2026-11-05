import Schema from '@deepseek-ai/schemastery'

export interface Config {
  memoryCap: number
  userCap: number
  enableInjection: boolean
  backupKeep: number
  memoryDir: string
  enableRecall: boolean
  enableAutoRecall: boolean
  recallBudgetChars: number
  /**
   * 维护报告认为某条目「冷」之前，它最多可以闲置多久。
   *
   * 45 天长到足以覆盖月度节奏（一条关于月末结算的规则，不该因为它是在 2 号写的
   * 就显得已经死了），又短到让一条真正过时的规则能在一次压缩周期内浮出水面。
   */
  staleAfterDays: number
  /** 年轻于此天数的条目永不被报为未使用；见 EntryIndex.cold。 */
  staleMinAgeDays: number
  /** profile 有技能目录时，把「记忆纪律」注册进去。 */
  enableSkill: boolean
}

/**
 * 上限默认取继承的 Hermes 部署最终定下的值（`weekly_memory_compact.py`：
 * MEMORY.md 2200，USER.md 1375）。做成配置项，是为了让部署能在压缩继承文件期间把
 * 上限调高，压缩完再调回来。
 */
export const Config: Schema<Config> = Schema.object({
  memoryCap: Schema.number().default(2200).description('Character cap for MEMORY.md.'),
  userCap: Schema.number().default(1375).description('Character cap for USER.md.'),
  enableInjection: Schema.boolean()
    .default(true)
    .description('Inject the memory documents as dynamic prompt context.'),
  backupKeep: Schema.number().default(12).description('How many backup directories to retain.'),
  memoryDir: Schema.string()
    .default('~/.dsh/memory')
    .description('Directory holding MEMORY.md, USER.md, and backups.'),
  enableRecall: Schema.boolean()
    .default(false)
    .description(
      'Expose memory_recall so the model can pull the entries relevant to the current request. ' +
        'Off by default because it only pays once the documents outgrow the inline injection budget: ' +
        'below that the whole memory is already in context, and a recall would inject a second copy.',
    ),
  recallBudgetChars: Schema.number()
    .default(1500)
    .description('Hard ceiling on how many characters one memory_recall call may inject.'),
  enableAutoRecall: Schema.boolean()
    .default(false)
    .description(
      'Recall relevant entries automatically at the first step of each turn, and append them to ' +
        'that turn only. Off by default for the same reason as enableRecall: while the documents fit ' +
        'the inline budget they are already in context, so an automatic recall would inject a second ' +
        'copy on every turn. Trivial turns (acknowledgements) are skipped, and a recall failure never ' +
        'fails the turn.',
    ),
  staleAfterDays: Schema.number()
    .default(45)
    .description(
      'How long an entry may go without a recorded hit before memory_maintenance lists it as cold. ' +
        'Cold entries are candidates for review, never for automatic deletion: an entry that is ' +
        'injected inline on every turn is in use without ever being counted.',
    ),
  staleMinAgeDays: Schema.number()
    .default(14)
    .description(
      'Entries younger than this are never reported as unused. A rule written yesterday has had one ' +
        'day of chances, and a report full of fresh entries trains its reader to ignore it.',
    ),
  enableSkill: Schema.boolean()
    .default(true)
    .description(
      'Register a `memory-curation` skill into the host skill catalog when the profile provides one. ' +
        'The skill carries the write-and-compress discipline as instructions loaded on demand, so it ' +
        'does not spend context on every request the way an injected protocol would. No-op when the ' +
        'profile has no skill registry.',
    ),
})
