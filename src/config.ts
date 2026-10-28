import Schema from '@deepseek-ai/schemastery'

export interface Config {
  memoryCap: number
  userCap: number
  enableInjection: boolean
  backupKeep: number
  memoryDir: string
  enableRecall: boolean
  recallBudgetChars: number
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
})
