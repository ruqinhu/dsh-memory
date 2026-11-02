import { describe, expect, it } from 'vitest'
import { installCurationSkill } from '../src/skill.js'

/**
 * A cordis context reduced to what the seam touches.
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
