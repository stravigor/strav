import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TemplateError } from '@strav/kernel'
import { tokenize } from '../src/tokenizer.ts'
import ViewEngine from '../src/engine.ts'

// ── Helpful error: whitespace before directive arguments ─────────────────────

describe('whitespace-before-paren diagnostic', () => {
  const expectSpaceError = (template: string, directive: string, line = 1) => {
    expect(() => tokenize(template)).toThrow(
      new RegExp(
        `@${directive} cannot have whitespace before its arguments at line ${line} — remove the space between "@${directive}" and "\\("\\.`
      )
    )
  }

  test('@if with space before paren', () => {
    expectSpaceError(`@if (x > 1)X@end`, 'if')
  })

  test('@elseif with space before paren', () => {
    expect(() => tokenize(`@if(a)A@elseif (b)B@end`)).toThrow(
      /@elseif cannot have whitespace before its arguments/
    )
  })

  test('@each with space before paren', () => {
    expectSpaceError(`@each (item in list)x@end`, 'each')
  })

  test('@section with space before paren', () => {
    expectSpaceError(`@section ('content')x@end`, 'section')
  })

  test('@include with space before paren', () => {
    expectSpaceError(`@include ('partial')`, 'include')
  })

  test('reports correct line number for the offending directive', () => {
    const template = `line one\nline two\n@if (cond)body@end`
    expect(() => tokenize(template)).toThrow(/at line 3 —/)
  })

  test('tab before paren is also caught', () => {
    expect(() => tokenize(`@if\t(x)X@end`)).toThrow(
      /@if cannot have whitespace before its arguments/
    )
  })

  test('correct form "@if(cond)" still parses without error', () => {
    expect(() => tokenize(`@if(x > 1)X@end`)).not.toThrow()
  })

  test('arg-less directives are not affected (e.g. @else with text after)', () => {
    // "@else (text)" is legitimate template: @else followed by literal text.
    expect(() => tokenize(`@if(a)A@else (text)B@end`)).not.toThrow()
  })
})

// ── Engine-level: errors include file path and line ──────────────────────────

function makeConfig(directory: string) {
  return {
    get(key: string, fallback?: unknown) {
      if (key === 'view.directory') return directory
      if (key === 'view.cache') return false
      return fallback
    },
  } as any
}

describe('template errors include file path and line', () => {
  test('compile error message includes "at <filePath>:<line>"', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strav-view-errors-'))
    writeFileSync(join(root, 'broken.strav'), `hello\nworld\n@if\nbody\n@end`)
    const engine = new ViewEngine(makeConfig(root))

    try {
      await engine.render('broken')
      throw new Error('render should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateError)
      const msg = (err as TemplateError).message
      // Original message still present
      expect(msg).toContain('@if requires a condition')
      // Clickable file:line location appended
      expect(msg).toMatch(/\n  at .*\/broken\.strav:3$/)
    }
  })

  test('whitespace-before-paren error also carries file path and line', async () => {
    const root = mkdtempSync(join(tmpdir(), 'strav-view-errors-'))
    writeFileSync(join(root, 'spaced.strav'), `\n@if (x)X@end`)
    const engine = new ViewEngine(makeConfig(root))

    try {
      await engine.render('spaced')
      throw new Error('render should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateError)
      const msg = (err as TemplateError).message
      expect(msg).toContain('remove the space')
      expect(msg).toMatch(/\n  at .*\/spaced\.strav:2$/)
    }
  })
})
