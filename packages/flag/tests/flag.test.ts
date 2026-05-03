import { describe, test, expect, beforeEach } from 'bun:test'
import { Emitter } from '@strav/kernel'
import FlagManager from '../src/flag_manager.ts'
import { ArrayDriver } from '../src/drivers/array_driver.ts'
import PendingScopedFeature from '../src/pending_scope.ts'
import { flag } from '../src/helpers.ts'
import { GLOBAL_SCOPE } from '../src/types.ts'
import type { Scopeable, FeatureClass } from '../src/types.ts'

// ── Mocks ────────────────────────────────────────────────────────────────

function mockConfig(overrides: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    flag: {
      default: 'array',
      drivers: {
        array: { driver: 'array' },
      },
      ...overrides,
    },
  }

  return {
    get(key: string, defaultValue?: unknown): unknown {
      const parts = key.split('.')
      let current: any = data
      for (const part of parts) {
        if (current === undefined || current === null) return defaultValue
        current = current[part]
      }
      return current !== undefined ? current : defaultValue
    },
    has(key: string): boolean {
      return this.get(key) !== undefined
    },
  } as any
}

function bootFlag(overrides: Record<string, unknown> = {}) {
  const config = mockConfig(overrides)
  FlagManager.reset()
  // Pass null db since we're using the array driver
  new FlagManager(null as any, config)
  return { config }
}

function mockScope(type: string, id: number): Scopeable {
  const obj = { id } as any
  Object.defineProperty(obj, 'constructor', { value: { name: type } })
  // Direct featureScope to ensure correct name
  obj.featureScope = () => type
  return obj
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('FlagManager', () => {
  beforeEach(() => {
    FlagManager.reset()
  })

  // ── Configuration ──────────────────────────────────────────────────

  test('reads config and exposes it', () => {
    bootFlag()
    expect(FlagManager.config.default).toBe('array')
  })

  test('throws when not configured', () => {
    expect(() => FlagManager.config).toThrow('not configured')
  })

  test('reset clears all state', () => {
    bootFlag()
    FlagManager.define('feat', true)
    FlagManager.reset()
    expect(() => FlagManager.config).toThrow('not configured')
  })

  // ── Feature definitions ────────────────────────────────────────────

  test('define with boolean', async () => {
    bootFlag()
    FlagManager.define('always-on', true)
    FlagManager.define('always-off', false)

    expect(await FlagManager.active('always-on')).toBe(true)
    expect(await FlagManager.active('always-off')).toBe(false)
  })

  test('define with closure', async () => {
    bootFlag()
    FlagManager.define('half-users', scope => {
      if (scope === GLOBAL_SCOPE) return false
      const id = parseInt(scope.split(':')[1])
      return id % 2 === 0
    })

    const even = mockScope('User', 42)
    const odd = mockScope('User', 43)

    expect(await FlagManager.active('half-users', even)).toBe(true)
    expect(await FlagManager.active('half-users', odd)).toBe(false)
  })

  test('define with async closure', async () => {
    bootFlag()
    FlagManager.define('async-feat', async () => 'variant-a')

    expect(await FlagManager.value('async-feat')).toBe('variant-a')
  })

  test('defineClass with static key', async () => {
    bootFlag()

    class BetaFeature implements FeatureClass {
      static readonly key = 'beta'
      resolve() {
        return true
      }
    }

    FlagManager.defineClass(BetaFeature)
    expect(await FlagManager.active('beta')).toBe(true)
  })

  test('defineClass infers key from class name', async () => {
    bootFlag()

    class NewCheckoutExperience implements FeatureClass {
      resolve() {
        return true
      }
    }

    FlagManager.defineClass(NewCheckoutExperience)
    expect(await FlagManager.active('new-checkout-experience')).toBe(true)
  })

  test('defined() lists all feature names', () => {
    bootFlag()
    FlagManager.define('feat-a', true)
    FlagManager.define('feat-b', false)

    class FeatC implements FeatureClass {
      static readonly key = 'feat-c'
      resolve() {
        return true
      }
    }
    FlagManager.defineClass(FeatC)

    const names = FlagManager.defined()
    expect(names).toContain('feat-a')
    expect(names).toContain('feat-b')
    expect(names).toContain('feat-c')
    expect(names).toHaveLength(3)
  })

  test('throws FeatureNotDefinedError for unknown feature', async () => {
    bootFlag()
    await expect(FlagManager.active('nope')).rejects.toThrow('not defined')
  })

  // ── Scope serialization ────────────────────────────────────────────

  test('serializeScope with null returns global', () => {
    expect(FlagManager.serializeScope(null)).toBe(GLOBAL_SCOPE)
    expect(FlagManager.serializeScope(undefined)).toBe(GLOBAL_SCOPE)
  })

  test('serializeScope with featureScope()', () => {
    const scope = mockScope('Team', 7)
    expect(FlagManager.serializeScope(scope)).toBe('Team:7')
  })

  test('serializeScope falls back to constructor.name', () => {
    class Organization {
      id = 99
    }
    const org = new Organization()
    expect(FlagManager.serializeScope(org)).toBe('Organization:99')
  })

  // ── Core resolution ────────────────────────────────────────────────

  test('value resolves and caches', async () => {
    bootFlag()
    let calls = 0
    FlagManager.define('counted', () => {
      calls++
      return true
    })

    await FlagManager.value('counted')
    await FlagManager.value('counted')
    expect(calls).toBe(1) // resolver called only once, then cached
  })

  test('value persists to store', async () => {
    bootFlag()
    FlagManager.define('persistent', () => 'hello')

    await FlagManager.value('persistent')

    // Flush cache and re-read from store
    FlagManager.flushCache()
    const val = await FlagManager.value('persistent')
    expect(val).toBe('hello')
  })

  test('active returns boolean', async () => {
    bootFlag()
    FlagManager.define('rich', () => 'variant-a')

    expect(await FlagManager.active('rich')).toBe(true) // truthy
  })

  test('inactive is inverse of active', async () => {
    bootFlag()
    FlagManager.define('off', false)

    expect(await FlagManager.inactive('off')).toBe(true)
  })

  test('rich values preserved', async () => {
    bootFlag()
    FlagManager.define('variant', () => ({ color: 'blue', weight: 42 }))

    const val = await FlagManager.value('variant')
    expect(val).toEqual({ color: 'blue', weight: 42 })
  })

  // ── when() conditional ─────────────────────────────────────────────

  test('when executes onActive when active', async () => {
    bootFlag()
    FlagManager.define('feat', () => 'variant-b')

    const result = await FlagManager.when(
      'feat',
      value => `active: ${value}`,
      () => 'inactive'
    )
    expect(result).toBe('active: variant-b')
  })

  test('when executes onInactive when inactive', async () => {
    bootFlag()
    FlagManager.define('feat', false)

    const result = await FlagManager.when(
      'feat',
      () => 'active',
      () => 'inactive'
    )
    expect(result).toBe('inactive')
  })

  // ── Scoped API (.for()) ────────────────────────────────────────────

  test('for() returns PendingScopedFeature', () => {
    bootFlag()
    const scoped = FlagManager.for(mockScope('User', 1))
    expect(scoped).toBeInstanceOf(PendingScopedFeature)
  })

  test('for(scope).active() scopes correctly', async () => {
    bootFlag()
    FlagManager.define('scoped', scope => scope === 'User:42')

    const user42 = mockScope('User', 42)
    const user99 = mockScope('User', 99)

    expect(await FlagManager.for(user42).active('scoped')).toBe(true)
    expect(await FlagManager.for(user99).active('scoped')).toBe(false)
  })

  test('for(scope).activate() stores for that scope', async () => {
    bootFlag()
    FlagManager.define('manual', false)

    const user = mockScope('User', 1)
    await FlagManager.for(user).activate('manual')

    // Global still inactive
    expect(await FlagManager.active('manual')).toBe(false)
    // User's scope is active
    expect(await FlagManager.for(user).active('manual')).toBe(true)
  })

  test('for(scope).values() returns batch', async () => {
    bootFlag()
    FlagManager.define('a', true)
    FlagManager.define('b', false)

    const user = mockScope('User', 1)
    const vals = await FlagManager.for(user).values(['a', 'b'])

    expect(vals.get('a')).toBe(true)
    expect(vals.get('b')).toBe(false)
  })

  // ── Manual activation/deactivation ─────────────────────────────────

  test('activate overrides stored value', async () => {
    bootFlag()
    FlagManager.define('feat', false)

    // Resolve first (stores false)
    expect(await FlagManager.active('feat')).toBe(false)

    // Activate
    await FlagManager.activate('feat')
    expect(await FlagManager.active('feat')).toBe(true)
  })

  test('deactivate overrides stored value', async () => {
    bootFlag()
    FlagManager.define('feat', true)

    expect(await FlagManager.active('feat')).toBe(true)

    await FlagManager.deactivate('feat')
    expect(await FlagManager.active('feat')).toBe(false)
  })

  test('activate with rich value', async () => {
    bootFlag()
    FlagManager.define('variant', () => 'a')

    await FlagManager.activate('variant', 'b')
    expect(await FlagManager.value('variant')).toBe('b')
  })

  test('activateForEveryone stores at global scope', async () => {
    bootFlag()
    FlagManager.define('global-feat', false)

    await FlagManager.activateForEveryone('global-feat')
    expect(await FlagManager.active('global-feat')).toBe(true)
  })

  test('deactivateForEveryone stores false at global scope', async () => {
    bootFlag()
    FlagManager.define('global-feat', true)

    await FlagManager.value('global-feat') // resolve
    await FlagManager.deactivateForEveryone('global-feat')
    expect(await FlagManager.active('global-feat')).toBe(false)
  })

  // ── flag:updated event payload (audit hook) ───────────────────────

  test('activate emits flag:updated with actor + previous value', async () => {
    bootFlag()
    FlagManager.define('feat', false)
    const events: any[] = []
    Emitter.on('flag:updated', (e: any) => events.push(e))

    await FlagManager.activate('feat', true, null, { type: 'admin', id: '7' })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      feature: 'feat',
      value: true,
      actor: { type: 'admin', id: '7' },
    })
    Emitter.removeAllListeners('flag:updated')
  })

  test('activate without actor emits actor: null', async () => {
    bootFlag()
    FlagManager.define('feat', false)
    const events: any[] = []
    Emitter.on('flag:updated', (e: any) => events.push(e))

    await FlagManager.activate('feat')

    expect(events[0].actor).toBeNull()
    Emitter.removeAllListeners('flag:updated')
  })

  test('deactivate emits flag:updated with actor', async () => {
    bootFlag()
    FlagManager.define('feat', true)
    await FlagManager.value('feat') // populate store
    const events: any[] = []
    Emitter.on('flag:updated', (e: any) => events.push(e))

    await FlagManager.deactivate('feat', null, { type: 'admin', id: '7' })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      feature: 'feat',
      value: false,
      actor: { type: 'admin', id: '7' },
    })
    Emitter.removeAllListeners('flag:updated')
  })

  test('for(scope).activate forwards the actor', async () => {
    bootFlag()
    FlagManager.define('feat', false)
    const user = { id: 5 }
    const events: any[] = []
    Emitter.on('flag:updated', (e: any) => events.push(e))

    await FlagManager.for(user).activate('feat', true, { type: 'admin', id: '99' })

    expect(events[0]).toMatchObject({
      feature: 'feat',
      value: true,
      actor: { type: 'admin', id: '99' },
    })
    Emitter.removeAllListeners('flag:updated')
  })

  // ── strictScopes ───────────────────────────────────────────────────

  test('strictScopes throws MissingScopeError on value() with no scope', async () => {
    bootFlag({ strictScopes: true })
    FlagManager.define('feat', false)
    await expect(FlagManager.value('feat')).rejects.toThrow(/strictScopes is enabled/)
  })

  test('strictScopes throws on values() (batch) with no scope', async () => {
    bootFlag({ strictScopes: true })
    FlagManager.define('a', false)
    FlagManager.define('b', false)
    await expect(FlagManager.values(['a', 'b'])).rejects.toThrow(/strictScopes is enabled/)
  })

  test('strictScopes allows reads when an explicit scope is provided', async () => {
    bootFlag({ strictScopes: true })
    FlagManager.define('feat', true)
    const user = mockScope('User', 1)
    const value = await FlagManager.value('feat', user)
    expect(value).toBe(true)
  })

  test('strictScopes does NOT block activate() with no scope (write path stays loose)', async () => {
    bootFlag({ strictScopes: true })
    FlagManager.define('feat', false)
    // Writes still allow null — explicit-global writes use this path,
    // and activateForEveryone() is the recommended way to do it.
    await FlagManager.activate('feat', true)
    // But the read-back via value() needs a scope, so test against
    // for(scope) or activateForEveryone path:
    await FlagManager.activateForEveryone('feat', true)
  })

  test('strictScopes default is false — null scope falls back to global', async () => {
    bootFlag()
    FlagManager.define('feat', () => 'global-value')
    const value = await FlagManager.value('feat')
    expect(value).toBe('global-value')
  })

  // ── Batch operations ───────────────────────────────────────────────

  test('values() resolves multiple features', async () => {
    bootFlag()
    FlagManager.define('x', true)
    FlagManager.define('y', false)
    FlagManager.define('z', () => 'variant')

    const vals = await FlagManager.values(['x', 'y', 'z'])
    expect(vals.get('x')).toBe(true)
    expect(vals.get('y')).toBe(false)
    expect(vals.get('z')).toBe('variant')
  })

  test('stored() lists feature names in store', async () => {
    bootFlag()
    FlagManager.define('a', true)
    FlagManager.define('b', false)

    await FlagManager.value('a')
    await FlagManager.value('b')

    const names = await FlagManager.stored()
    expect(names).toContain('a')
    expect(names).toContain('b')
  })

  // ── Eager loading ──────────────────────────────────────────────────

  test('load() pre-caches values for multiple scopes', async () => {
    bootFlag()
    let calls = 0
    FlagManager.define('preload', () => {
      calls++
      return true
    })

    const users = [mockScope('User', 1), mockScope('User', 2), mockScope('User', 3)]
    await FlagManager.load(['preload'], users)

    expect(calls).toBe(3) // resolved for each scope

    // Subsequent checks should be cached
    calls = 0
    for (const u of users) {
      await FlagManager.for(u).active('preload')
    }
    expect(calls).toBe(0) // all from cache
  })

  // ── Cleanup ────────────────────────────────────────────────────────

  test('forget clears stored value for scope', async () => {
    bootFlag()
    let calls = 0
    FlagManager.define('forgettable', () => {
      calls++
      return true
    })

    await FlagManager.value('forgettable')
    expect(calls).toBe(1)

    await FlagManager.forget('forgettable')

    // Next access should re-resolve
    await FlagManager.value('forgettable')
    expect(calls).toBe(2)
  })

  test('purge clears all scopes for a feature', async () => {
    bootFlag()
    FlagManager.define('purgeable', true)

    const u1 = mockScope('User', 1)
    const u2 = mockScope('User', 2)

    await FlagManager.for(u1).value('purgeable')
    await FlagManager.for(u2).value('purgeable')

    await FlagManager.purge('purgeable')

    const names = await FlagManager.stored()
    expect(names).not.toContain('purgeable')
  })

  test('purgeAll clears everything', async () => {
    bootFlag()
    FlagManager.define('a', true)
    FlagManager.define('b', true)

    await FlagManager.value('a')
    await FlagManager.value('b')

    await FlagManager.purgeAll()

    const names = await FlagManager.stored()
    expect(names).toHaveLength(0)
  })

  // ── flushCache ─────────────────────────────────────────────────────

  test('flushCache forces re-read from store', async () => {
    bootFlag()
    FlagManager.define('cached', () => 'original')

    await FlagManager.value('cached')

    // Manually update store behind the cache
    await FlagManager.store().set('cached', GLOBAL_SCOPE, 'updated')
    FlagManager.flushCache()

    const val = await FlagManager.value('cached')
    expect(val).toBe('updated')
  })

  // ── Driver management ──────────────────────────────────────────────

  test('store() returns array driver', () => {
    bootFlag()
    const store = FlagManager.store()
    expect(store).toBeInstanceOf(ArrayDriver)
    expect(store.name).toBe('array')
  })

  test('store instances are cached', () => {
    bootFlag()
    expect(FlagManager.store()).toBe(FlagManager.store())
  })

  test('throws on unknown driver', () => {
    bootFlag({ drivers: { custom: { driver: 'custom' } }, default: 'custom' })
    expect(() => FlagManager.store()).toThrow('Unknown flag driver')
  })

  test('extend registers custom driver', () => {
    bootFlag({ drivers: { custom: { driver: 'custom' } }, default: 'custom' })
    FlagManager.extend('custom', () => new ArrayDriver())

    const store = FlagManager.store()
    expect(store).toBeInstanceOf(ArrayDriver)
  })
})

// ── ArrayDriver ──────────────────────────────────────────────────────────

describe('ArrayDriver', () => {
  test('get/set round-trip', async () => {
    const driver = new ArrayDriver()
    await driver.set('feat', 'User:1', true)
    expect(await driver.get('feat', 'User:1')).toBe(true)
  })

  test('get returns undefined for missing', async () => {
    const driver = new ArrayDriver()
    expect(await driver.get('nope', 'User:1')).toBeUndefined()
  })

  test('getMany returns only stored features', async () => {
    const driver = new ArrayDriver()
    await driver.set('a', 'User:1', true)
    await driver.set('b', 'User:1', false)

    const result = await driver.getMany(['a', 'b', 'c'], 'User:1')
    expect(result.size).toBe(2)
    expect(result.get('a')).toBe(true)
    expect(result.get('b')).toBe(false)
    expect(result.has('c')).toBe(false)
  })

  test('setMany stores multiple', async () => {
    const driver = new ArrayDriver()
    await driver.setMany([
      { feature: 'a', scope: 'x', value: 1 },
      { feature: 'b', scope: 'x', value: 2 },
    ])
    expect(await driver.get('a', 'x')).toBe(1)
    expect(await driver.get('b', 'x')).toBe(2)
  })

  test('forget removes entry', async () => {
    const driver = new ArrayDriver()
    await driver.set('feat', 'User:1', true)
    await driver.forget('feat', 'User:1')
    expect(await driver.get('feat', 'User:1')).toBeUndefined()
  })

  test('purge removes all scopes for a feature', async () => {
    const driver = new ArrayDriver()
    await driver.set('feat', 'User:1', true)
    await driver.set('feat', 'User:2', true)
    await driver.set('other', 'User:1', true)

    await driver.purge('feat')

    expect(await driver.get('feat', 'User:1')).toBeUndefined()
    expect(await driver.get('feat', 'User:2')).toBeUndefined()
    expect(await driver.get('other', 'User:1')).toBe(true)
  })

  test('purgeAll clears everything', async () => {
    const driver = new ArrayDriver()
    await driver.set('a', 'x', 1)
    await driver.set('b', 'y', 2)
    await driver.purgeAll()
    expect(await driver.featureNames()).toHaveLength(0)
  })

  test('featureNames returns distinct names', async () => {
    const driver = new ArrayDriver()
    await driver.set('a', 'x', 1)
    await driver.set('a', 'y', 2)
    await driver.set('b', 'x', 3)

    const names = await driver.featureNames()
    expect(names.sort()).toEqual(['a', 'b'])
  })

  test('allFor returns all records for a feature', async () => {
    const driver = new ArrayDriver()
    await driver.set('feat', 'User:1', true)
    await driver.set('feat', 'User:2', false)

    const records = await driver.allFor('feat')
    expect(records).toHaveLength(2)
    expect(records[0].scope).toBe('User:1')
    expect(records[0].value).toBe(true)
    expect(records[1].scope).toBe('User:2')
    expect(records[1].value).toBe(false)
  })
})

// ── Helper delegation ────────────────────────────────────────────────────

describe('flag helper', () => {
  beforeEach(() => {
    FlagManager.reset()
  })

  test('define and active delegate to manager', async () => {
    bootFlag()
    flag.define('helper-feat', true)
    expect(await flag.active('helper-feat')).toBe(true)
  })

  test('for() returns scoped feature', async () => {
    bootFlag()
    flag.define('scoped', scope => scope === 'User:1')

    const user = mockScope('User', 1)
    expect(await flag.for(user).active('scoped')).toBe(true)
  })

  test('activate/deactivate delegate', async () => {
    bootFlag()
    flag.define('toggle', false)

    await flag.value('toggle') // resolve
    await flag.activate('toggle')
    expect(await flag.active('toggle')).toBe(true)

    await flag.deactivate('toggle')
    expect(await flag.active('toggle')).toBe(false)
  })

  test('purge delegates', async () => {
    bootFlag()
    flag.define('purgeable', true)
    await flag.value('purgeable')
    await flag.purge('purgeable')

    const names = await flag.stored()
    expect(names).not.toContain('purgeable')
  })

  test('defined() delegates', () => {
    bootFlag()
    flag.define('x', true)
    expect(flag.defined()).toContain('x')
  })

  test('store() delegates', () => {
    bootFlag()
    expect(flag.store()).toBeInstanceOf(ArrayDriver)
  })

  test('flushCache delegates', async () => {
    bootFlag()
    flag.define('c', () => 'v1')
    await flag.value('c')
    await flag.store().set('c', GLOBAL_SCOPE, 'v2')
    flag.flushCache()
    expect(await flag.value('c')).toBe('v2')
  })
})
