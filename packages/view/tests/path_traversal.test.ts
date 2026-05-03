import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TemplateError } from '@strav/kernel'
import ViewEngine from '../src/engine.ts'

// Build a minimal Configuration mock for ViewEngine — only `get` is used.
function makeConfig(directory: string) {
  return {
    get(key: string, fallback?: unknown) {
      if (key === 'view.directory') return directory
      if (key === 'view.cache') return false
      return fallback
    },
  } as any
}

function setupEngine(): { engine: ViewEngine; root: string } {
  const root = mkdtempSync(join(tmpdir(), 'strav-view-traversal-'))
  // Drop a real template so the engine can render legitimate names
  writeFileSync(join(root, 'welcome.strav'), 'hello')
  // And a nested one for the dot-notation case
  mkdirSync(join(root, 'auth'), { recursive: true })
  writeFileSync(join(root, 'auth', 'reset.strav'), 'reset')
  const engine = new ViewEngine(makeConfig(root))
  return { engine, root }
}

describe('ViewEngine.resolvePath path traversal', () => {
  const { engine } = setupEngine()

  const reject = (name: string, label = name) =>
    test(`rejects ${JSON.stringify(label)}`, async () => {
      await expect(engine.render(name)).rejects.toBeInstanceOf(TemplateError)
    })

  reject('/etc/passwd', 'absolute path')
  reject('\\windows\\system32', 'backslash absolute')
  reject('foo\0bar', 'embedded null byte')

  test('renders a legitimate top-level name', async () => {
    const out = await engine.render('welcome')
    expect(out).toContain('hello')
  })

  test('renders a dot-notation subpath', async () => {
    const out = await engine.render('auth.reset')
    expect(out).toContain('reset')
  })

  test('rejects names that resolve outside the configured view directory', async () => {
    // A name that would slip past the regex but somehow resolves outside —
    // the resolved-path check is the backstop. We can't easily craft such
    // a name with current logic, but we can confirm the engine throws on
    // structurally-suspicious input rather than silently loading the
    // wrong file.
    await expect(engine.render('/foo')).rejects.toBeInstanceOf(TemplateError)
  })
})
