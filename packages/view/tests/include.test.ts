import { describe, test, expect } from 'bun:test'
import { tokenize } from '../src/tokenizer.ts'
import { compile } from '../src/compiler.ts'
import { escapeHtml } from '../src/escape.ts'

type IncludeCall = { name: string; data: Record<string, unknown> }

/**
 * Compile a template and run it, capturing every @include invocation so tests
 * can assert on the partial name and the data object passed to it.
 */
async function renderCapturingIncludes(
  template: string,
  data: Record<string, unknown> = {}
): Promise<{ output: string; includes: IncludeCall[] }> {
  const includes: IncludeCall[] = []
  const includeFn = (name: string, includeData: Record<string, unknown> = {}) => {
    includes.push({ name, data: includeData })
    return `[${name}]`
  }
  const tokens = tokenize(template)
  const result = compile(tokens)
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const fn = new AsyncFunction('__data', '__escape', '__include', `with (__data) {\n${result.code}\n}`)
  const renderResult = await fn(data, escapeHtml, includeFn)
  return { output: renderResult.output, includes }
}

// ── @include data objects spanning multiple lines ────────────────────────────

describe('@include with multi-line data', () => {
  test('accepts a data object broken across lines', async () => {
    const template = `@include('partials/badge', {
      tone: 'cobalt',
      text: 'hello'
    })`
    const { output, includes } = await renderCapturingIncludes(template)
    expect(output).toBe('[partials/badge]')
    expect(includes).toEqual([
      { name: 'partials/badge', data: { tone: 'cobalt', text: 'hello' } },
    ])
  })

  test('accepts a nested array of objects across lines', async () => {
    const template = `@include('partials/value-card', {
      iconClass: 'fas fa-user',
      label: 'For freelancers',
      bullets: [
        { t: 'Hard cap of 15 proposals', d: 'See slot fill before you apply' },
        { t: 'Auto-refund when clients ghost', d: 'A deposit keeps them honest' },
      ],
    })`
    const { includes } = await renderCapturingIncludes(template)
    expect(includes[0]!.name).toBe('partials/value-card')
    expect(includes[0]!.data).toEqual({
      iconClass: 'fas fa-user',
      label: 'For freelancers',
      bullets: [
        { t: 'Hard cap of 15 proposals', d: 'See slot fill before you apply' },
        { t: 'Auto-refund when clients ghost', d: 'A deposit keeps them honest' },
      ],
    })
  })

  test('single-line form still works (regression)', async () => {
    const { includes } = await renderCapturingIncludes(
      `@include('partials/badge', { tone: 'cobalt', text: 'v1 launch' })`
    )
    expect(includes[0]!.data).toEqual({ tone: 'cobalt', text: 'v1 launch' })
  })

  test('@include with no data still works', async () => {
    const { includes } = await renderCapturingIncludes(`@include('partials/footer')`)
    expect(includes).toEqual([{ name: 'partials/footer', data: {} }])
  })

  test('a closing paren inside a string literal does not end the call early', async () => {
    const template = `@include('partials/badge', {
      text: 'ghosted (no reply)',
    })`
    const { includes } = await renderCapturingIncludes(template)
    expect(includes[0]!.data).toEqual({ text: 'ghosted (no reply)' })
  })
})

// ── Line tracking stays accurate after multi-line directive arguments ────────

describe('line numbers after a multi-line @include', () => {
  test('a later directive error reports its true physical line', () => {
    // The @if on line 5 is missing its condition. Before newlines inside
    // directive arguments were counted, this reported "line 2".
    const template = `@include('partials/badge', {
  tone: 'cobalt',
  text: 'hello'
})
@if
body
@end`
    expect(() => compile(tokenize(template))).toThrow(
      /@if requires a condition at line 5/
    )
  })
})
