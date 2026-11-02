import { describe, expect, it } from 'vitest'
import { CURATION_SKILL } from '../src/skill.js'

describe('curation skill', () => {
  it('uses a kebab-case name the catalog accepts', () => {
    // The registry validates the shape before caching, so a malformed name fails the
    // whole catalog rather than just this skill.
    expect(CURATION_SKILL.name).toBe('memory-curation')
    expect(CURATION_SKILL.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  })

  it('is routable by the model and by the owner', () => {
    expect(CURATION_SKILL.invocation?.modelInvocable).toBe(true)
    expect(CURATION_SKILL.invocation?.userInvocable).toBe(true)
    // The description is the only part that reaches the catalog, so it has to say
    // when to load this, not what the plugin is.
    expect(CURATION_SKILL.description).toContain('cap')
  })

  it('names the tools it tells the model to use', () => {
    // A procedure that refers to a tool by a stale name is worse than no procedure:
    // the model follows it into a dead end and reports the dead end as a result.
    for (const tool of ['memory_search', 'memory_append', 'memory_replace', 'memory_get', 'memory_maintenance']) {
      expect(CURATION_SKILL.content).toContain(tool)
    }
  })

  it('reserves room for the caps by explaining what the failure means', () => {
    // The one rule that turns a confusing rejection into a compression pass.
    expect(CURATION_SKILL.content).toContain('rejected')
  })
})
