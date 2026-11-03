import { describe, expect, it } from 'vitest'
import { CURATION_SKILL, installCurationSkill } from '../src/skill.js'

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

/**
 * A cordis context reduced to what the registration seam touches.
 *
 * These tests are about the wiring, not the registry: the registry belongs to
 * `dsh-skill`. What can go wrong here — registering into the wrong context,
 * requiring a service a profile may not have, or leaving the registration behind
 * when the plugin unloads — is visible from the shape of the calls.
 */
function fakeContext() {
  const registered: { name?: string }[] = []
  const disposed: string[] = []
  const injected: unknown[] = []
  const pending: (() => void)[] = []

  const scoped = {
    skills: {
      register: (skill: { name?: string }) => {
        registered.push(skill)
        return () => disposed.push('skill')
      },
    },
    effect: (fn: () => unknown) => {
      const dispose = fn()
      if (typeof dispose === 'function') pending.push(dispose as () => void)
    },
  }

  const ctx = {
    inject: (deps: unknown, callback: (scope: unknown) => void) => {
      injected.push(deps)
      callback(scoped)
    },
  }

  const unload = () => {
    for (const dispose of pending) dispose()
  }

  return { ctx, registered, disposed, injected, unload }
}

describe('installCurationSkill', () => {
  it('registers through a deferred child fiber, not a required dependency', () => {
    // A `static inject` entry would make the whole plugin refuse to load in a
    // profile without a skill registry — trading all of memory for one skill.
    const { ctx, registered, injected } = fakeContext()

    installCurationSkill(ctx as never)

    expect(injected).toEqual([['skills']])
    expect(registered).toHaveLength(1)
    expect(registered[0]).toMatchObject({ name: 'memory-curation' })
  })

  it('disposes the registration when the scope unloads', () => {
    const { ctx, disposed, unload } = fakeContext()

    installCurationSkill(ctx as never)
    expect(disposed).toHaveLength(0)

    unload()
    expect(disposed).toEqual(['skill'])
  })
})
