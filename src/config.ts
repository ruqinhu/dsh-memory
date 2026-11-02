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
   * How long an entry may go unused before the maintenance report calls it cold.
   *
   * 45 days is long enough to cover a monthly cadence (a rule about month-end
   * settlement must not look dead because it was written on the 2nd) and short
   * enough that a genuinely obsolete rule surfaces within one compression cycle.
   */
  staleAfterDays: number
  /** Entries younger than this are never reported as unused; see EntryIndex.cold. */
  staleMinAgeDays: number
  /** Register the curation skill into the host skill catalog when one exists. */
  enableSkill: boolean
}

/**
 * Caps default to the values the inherited Hermes deployment settled on
 * (`weekly_memory_compact.py`: MEMORY.md 2200, USER.md 1375). They are
 * configuration so a deployment can raise them while the inherited files are
 * being compressed, then lower them back.
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
