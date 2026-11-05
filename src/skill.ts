import type { Context } from '@deepseek-ai/cordis'
import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

/**
 * 把「记忆纪律」做成技能，而不是每请求注入的协议。
 *
 * 一份解释怎么写记忆的提示，要被看见就必须每次请求都发一遍 —— 而这正是本插件存在
 * 的意义所反对的：一段永远在场的说明，就是把上下文花在「写规则的规则」上。宿主技能
 * 目录把这个取舍翻了过来：模型只看到一行，流程只在真正碰记忆的那些回合被加载。
 *
 * 正文有意写得程序化且短。关于记忆的一切事实都在文档里；一个复述这些事实的技能，
 * 会在第一次压缩条目时就过期。
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
 * profile 有技能注册表时，把技能注册进去。
 *
 * 用 `ctx.inject` 而不是 `static inject` 条目：一个把 `skills` 声明为必需依赖的
 * 插件，在没有技能注册表的 profile 里会拒绝加载，而为了多一个技能丢掉全部记忆是很糟
 * 的交易。那种情况下，子 fiber 压根不会启动。
 */
export function installCurationSkill(ctx: Context): void {
  ctx.inject(['skills'], (scoped) => {
    scoped.effect(() => scoped.skills.register(CURATION_SKILL))
  })
}
