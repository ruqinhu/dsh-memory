import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

/**
 * The memory discipline, as a skill rather than an injected protocol.
 *
 * A prompt that explains how to write memory has to be sent on every request to be
 * seen, and that is the one thing this plugin exists to avoid: an instruction
 * block that is always present is context spent on the rules for writing rules.
 * The host skill catalog inverts the trade — the model sees one line, and the
 * procedure is loaded only in the turns that actually touch memory.
 *
 * The content is deliberately procedural and short. Everything factual about the
 * memory lives in the documents; a skill that restated it would go stale the first
 * time an entry was compressed.
 */
export const CURATION_SKILL: SkillRegistration = {
  name: 'memory-curation',
  source: 'runtime',
  description:
    'Decide what belongs in durable memory, write it without duplicating, and compress the ' +
    'documents when they exceed their character cap. Use when the owner states a lasting ' +
    'preference or constraint, corrects you on something that will recur, or when memory ' +
    'maintenance reports the documents near or over their cap.',
  invocation: { modelInvocable: true, userInvocable: true },
  content: [
    '# Memory curation',
    '',
    'Memory is two documents: `MEMORY.md` (durable facts and rules) and `USER.md` (who the owner is).',
    'Entries are separated by `§`. Both have a hard character cap; a write that would exceed it is',
    'rejected rather than truncated, so hitting the cap means compressing, not retrying.',
    '',
    '## What to save',
    '',
    'Save what will still be true and useful in a month: standing preferences, hard constraints,',
    'recurring corrections, stable identifiers (paths, account names, endpoints), and decisions with',
    'their reasons. Do not save: task state ("the build is running"), things already in the repository,',
    'one-off outputs, or credentials and tokens.',
    '',
    'Write when the owner says something that will recur, or when you get corrected on something you',
    'would otherwise get wrong again. One rule per entry; keep the numbers, names, and commands exact —',
    'a rule whose detail was smoothed away during compression is worse than no rule.',
    '',
    '## Writing',
    '',
    '1. `memory_search` the topic first. A near-duplicate is the most common failure: two entries that',
    '   say the same thing half as well each.',
    '2. New fact with no existing entry: `memory_append`.',
    '3. New fact superseding an old rule: `memory_replace` the old text, so the stale and the current',
    '   rule never coexist.',
    '4. Whole-document rewrite only when a compression pass genuinely restructures things;',
    '   `memory_write` replaces everything and is the easiest way to lose a rule.',
    '',
    '## Reading',
    '',
    'Small documents are injected in full. Once they outgrow the inline budget you get an index of',
    'ids instead: `memory_get` with an id reads one entry in full, `memory_search` finds entries by',
    'keyword. Ids are derived from entry text, so an id from an earlier turn may no longer resolve —',
    'that means the rule changed, not that the tool broke.',
    '',
    '## Compressing',
    '',
    'Run `memory_maintenance` first: it backs up, reports usage, and lists entries that have not been',
    'recalled recently. Use that list as evidence — an entry that is never used is a better candidate',
    'than one you merely find less interesting. Cold is not the same as dead: an entry injected inline',
    'on every request is in use without ever being counted, so read a cold entry before cutting it.',
    '',
    'Merge before deleting. Two rules about the same topic usually compress into one entry shorter',
    'than either, and the merged rule keeps both constraints. When dropping something, prefer the',
    'entry whose content is genuinely obsolete over the one that is merely old.',
    '',
    'Re-run `memory_maintenance` after compressing to confirm usage is back under the cap.',
  ].join('\n'),
}

/**
 * Register the skill on the host's registry when the profile has one.
 *
 * `ctx.inject` rather than a `static inject` entry: a plugin that requires `skills`
 * refuses to load in a profile without a skill registry, and losing memory
 * entirely to gain a skill would be a bad trade. The child fiber simply never
 * starts in that case.
 */
export function installCurationSkill(ctx: Context): void {
  ctx.inject(['skills'], (scoped) => {
    scoped.effect(() => scoped.skills.register(CURATION_SKILL))
  })
}
