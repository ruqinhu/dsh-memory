import Schema from '@deepseek-ai/schemastery'

export interface Config {
  memoryCap: number
  userCap: number
  enableInjection: boolean
  backupKeep: number
  memoryDir: string
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
})
