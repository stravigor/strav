import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { IslandBuilder } from '../src/islands/island_builder.ts'
import { resolve, join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'

const FIXTURES = resolve(import.meta.dir, 'fixtures')
const APP = resolve(FIXTURES, 'islands/app/islands')
const AUTH = resolve(FIXTURES, 'islands/auth/islands')
const BILLING = resolve(FIXTURES, 'islands/billing/islands')
const DUP_A = resolve(FIXTURES, 'islands/dup-a/islands')
const DUP_B = resolve(FIXTURES, 'islands/dup-b/islands')
const APP_SCSS = resolve(FIXTURES, 'islands/css/app.scss')
const PKG_FROM = FIXTURES // node_modules/@test/pkg-with-islands lives here

// ── Backward compatibility ───────────────────────────────────────────────────

describe('IslandBuilder — backward compat', () => {
  test('legacy islandsDir alone creates one anonymous source', () => {
    const b = new IslandBuilder({ islandsDir: APP })
    const src = b.cssSrc
    expect(src).toBeNull()
    // Discovery names are unprefixed
    const islands = (b as any).discoverIslands() as { name: string }[]
    expect(islands.map(i => i.name).sort()).toEqual(['counter', 'forms/contact'])
  })

  test('top-level css attaches to the anonymous source', () => {
    const b = new IslandBuilder({
      islandsDir: APP,
      css: { entry: APP_SCSS },
    })
    expect(b.cssSrcs.has('default')).toBe(true)
  })

  test('zero-config defaults still construct', () => {
    // No islandsDir → defaults to './resources/islands'; that dir likely doesn't
    // exist in the test cwd, but the constructor must not throw.
    expect(() => new IslandBuilder()).not.toThrow()
  })
})

// ── Source validation ────────────────────────────────────────────────────────

describe('IslandBuilder — source validation', () => {
  test('two anonymous sources throws', () => {
    expect(
      () =>
        new IslandBuilder({
          sources: [{ islandsDir: APP }, { islandsDir: AUTH }],
        })
    ).toThrow(/Only one source may omit 'namespace'/)
  })

  test('duplicate namespaces throws', () => {
    expect(
      () =>
        new IslandBuilder({
          sources: [
            { islandsDir: AUTH, namespace: 'auth' },
            { islandsDir: BILLING, namespace: 'auth' },
          ],
        })
    ).toThrow(/Duplicate namespace "auth"/)
  })

  test('one anonymous + one namespaced is fine', () => {
    expect(
      () =>
        new IslandBuilder({
          sources: [{ islandsDir: APP }, { islandsDir: AUTH, namespace: 'auth' }],
        })
    ).not.toThrow()
  })
})

// ── Multi-source discovery ───────────────────────────────────────────────────

describe('IslandBuilder — discoverIslands', () => {
  test('namespaces are applied to component names', () => {
    const b = new IslandBuilder({
      sources: [
        { islandsDir: APP },
        { islandsDir: AUTH, namespace: 'auth' },
        { islandsDir: BILLING, namespace: 'billing' },
      ],
    })
    const islands = (b as any).discoverIslands() as { name: string }[]
    expect(islands.map(i => i.name).sort()).toEqual([
      'auth/login-form',
      'billing/checkout',
      'counter',
      'forms/contact',
    ])
  })

  test('duplicate component name across sources is detected', () => {
    // Two anonymous sources collide at validation; bypass by mutating after construct.
    const b = new IslandBuilder({ sources: [{ islandsDir: DUP_A }] })
    ;(b as any).sources.push({ islandsDir: DUP_B, label: 'dup-b' })
    expect(() => (b as any).discoverIslands()).toThrow(/Duplicate component "login"/)
  })
})

// ── CSS namespacing ──────────────────────────────────────────────────────────

describe('IslandBuilder — CSS namespacing', () => {
  test('per-source single CSS string uses namespace as key', () => {
    const b = new IslandBuilder({
      sources: [
        { islandsDir: AUTH, namespace: 'auth', css: APP_SCSS },
      ],
    })
    expect(b.cssSrcs.has('auth')).toBe(true)
  })

  test('per-source named CSS entries get namespace-prefixed keys', () => {
    const b = new IslandBuilder({
      sources: [
        {
          islandsDir: AUTH,
          namespace: 'auth',
          css: { theme: APP_SCSS, layout: APP_SCSS },
        },
      ],
    })
    expect(b.cssSrcs.has('auth/theme')).toBe(true)
    expect(b.cssSrcs.has('auth/layout')).toBe(true)
  })

  test('CSS key collision across sources throws', () => {
    expect(
      () =>
        new IslandBuilder({
          sources: [
            { islandsDir: AUTH, namespace: 'auth', css: APP_SCSS },
          ],
          // Same key 'auth' produced by another source via single string with namespace 'auth'
          // is impossible without duplicate namespace; collision happens when two arrays produce the same suffix.
          css: { entry: { auth: APP_SCSS } }, // top-level produces key 'auth'
        })
    ).toThrow(/Duplicate CSS key "auth"/)
  })
})

// ── Setup file discovery ─────────────────────────────────────────────────────

describe('IslandBuilder — setup files', () => {
  let tmpRoot: string
  let appSetup: string
  let pkgSetup: string

  beforeAll(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'island-setup-'))
    appSetup = join(tmpRoot, 'app/islands')
    pkgSetup = join(tmpRoot, 'pkg/islands')
    mkdirSync(appSetup, { recursive: true })
    mkdirSync(pkgSetup, { recursive: true })
    writeFileSync(join(appSetup, 'a.vue'), '<template><div/></template>')
    writeFileSync(join(pkgSetup, 'b.vue'), '<template><div/></template>')
    writeFileSync(join(appSetup, 'setup.ts'), 'export default function (app) {}')
    writeFileSync(join(pkgSetup, 'setup.ts'), 'export default function (app) {}')
  })

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true })
  })

  test('discovers one setup file per source in declared order', () => {
    const b = new IslandBuilder({
      sources: [
        { islandsDir: appSetup },
        { islandsDir: pkgSetup, namespace: 'pkg' },
      ],
    })
    const setups = (b as any).discoverSetupFiles() as { path: string; label: string }[]
    expect(setups.length).toBe(2)
    expect(setups[0].path).toContain('app/islands/setup.ts')
    expect(setups[1].path).toContain('pkg/islands/setup.ts')
  })

  test('generated entry source invokes all setups', () => {
    const b = new IslandBuilder({
      sources: [
        { islandsDir: appSetup },
        { islandsDir: pkgSetup, namespace: 'pkg' },
      ],
    })
    const islands = (b as any).discoverIslands()
    const entry = (b as any).generateEntry(islands) as string
    expect(entry).toContain('import __setup_0')
    expect(entry).toContain('import __setup_1')
    expect(entry).toContain('var __setups = [__setup_0, __setup_1]')
    expect(entry).toContain('__setups[i](app)')
  })
})

// ── Generated entry ──────────────────────────────────────────────────────────

describe('IslandBuilder — generated entry', () => {
  test('component map uses fully-qualified names as keys', () => {
    const b = new IslandBuilder({
      sources: [
        { islandsDir: APP },
        { islandsDir: AUTH, namespace: 'auth' },
        { islandsDir: BILLING, namespace: 'billing' },
      ],
    })
    const islands = (b as any).discoverIslands()
    const entry = (b as any).generateEntry(islands) as string
    expect(entry).toContain("'counter': __c")
    expect(entry).toContain("'forms/contact': __c")
    expect(entry).toContain("'auth/login-form': __c")
    expect(entry).toContain("'billing/checkout': __c")
  })

  test('mount lookup falls back to PascalCase so <vue:copy-button> resolves CopyButton', () => {
    const b = new IslandBuilder({ islandsDir: APP })
    const islands = (b as any).discoverIslands()
    const entry = (b as any).generateEntry(islands) as string
    expect(entry).toContain('function __toPascalCase')
    expect(entry).toContain('components[name] || components[__toPascalCase(name)]')

    // Verify the helper itself produces the right transforms.
    const helper = new Function(
      "return function __toPascalCase(s) { return s.replace(/(^|-)(\\w)/g, function(_m, _sep, ch) { return ch.toUpperCase(); }); }"
    )() as (s: string) => string
    expect(helper('copy-button')).toBe('CopyButton')
    expect(helper('MyComp')).toBe('MyComp')
    expect(helper('counter')).toBe('Counter')
  })
})

// ── Package source resolution ────────────────────────────────────────────────

describe('IslandBuilder — package sources', () => {
  test('resolves a package via strav.islands manifest', () => {
    const b = new IslandBuilder({
      packages: ['@test/pkg-with-islands'],
      packagesFrom: PKG_FROM,
    })
    const islands = (b as any).discoverIslands() as { name: string }[]
    expect(islands.map(i => i.name)).toContain('admin/dashboard')
    expect(b.cssSrcs.has('admin/admin')).toBe(true)
  })

  test('missing manifest throws a helpful error', () => {
    expect(
      () =>
        new IslandBuilder({
          packages: ['@strav/view'], // installed package without strav.islands
          packagesFrom: PKG_FROM,
        })
    ).toThrow(/no "strav\.islands" field/)
  })

  test('unresolvable package throws', () => {
    expect(
      () =>
        new IslandBuilder({
          packages: ['@nonexistent/pkg'],
          packagesFrom: PKG_FROM,
        })
    ).toThrow(/Cannot resolve package/)
  })
})
