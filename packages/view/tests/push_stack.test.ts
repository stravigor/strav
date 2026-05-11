import { describe, test, expect } from 'bun:test'
import { tokenize } from '../src/tokenizer.ts'
import { compile } from '../src/compiler.ts'
import { escapeHtml } from '../src/escape.ts'

/**
 * Compile a template string and evaluate it with the given data.
 * Returns the rendered HTML output and stacks for testing.
 */
async function render(
  template: string,
  data: Record<string, unknown> = {},
  includeFn: (name: string, data?: Record<string, unknown>) => string | Promise<string> = () => ''
): Promise<{ output: string; stacks: Record<string, string[]>; blocks: Record<string, string> }> {
  const tokens = tokenize(template)
  const result = compile(tokens)
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const fn = new AsyncFunction('__data', '__escape', '__include', `with (__data) {\n${result.code}\n}`)
  const renderResult = await fn(data, escapeHtml, includeFn)
  return {
    output: renderResult.output,
    stacks: renderResult.stacks,
    blocks: renderResult.blocks,
  }
}

/**
 * Helper function to render just output for simpler tests
 */
async function renderOutput(template: string, data: Record<string, unknown> = {}): Promise<string> {
  const result = await render(template, data)
  return result.output
}

// ── @stack ─────────────────────────────────────────────────────────────────

describe('@stack', () => {
  test('outputs empty string when stack is empty', async () => {
    const output = await renderOutput(`<html><head>@stack('styles')</head></html>`)
    expect(output).toBe('<html><head></head></html>')
  })

  test('outputs nothing when stack does not exist', async () => {
    const output = await renderOutput(`<html><head>@stack('nonexistent')</head></html>`)
    expect(output).toBe('<html><head></head></html>')
  })
})

// ── @push ─────────────────────────────────────────────────────────────────

describe('@push', () => {
  test('pushes content to a stack', async () => {
    const template = `@push('scripts')<script>console.log('hello')</script>@end Scripts: @stack('scripts')`
    const output = await renderOutput(template)
    expect(output.trim()).toBe("Scripts: <script>console.log('hello')</script>")
  })

  test('multiple pushes accumulate in order', async () => {
    const template = `@push('scripts')<script>first</script>@end@push('scripts')<script>second</script>@end@stack('scripts')`
    const output = await renderOutput(template)
    expect(output.trim()).toBe('<script>first</script><script>second</script>')
  })

  test('pushes to different stacks independently', async () => {
    const template = `@push('styles')<link rel="stylesheet" href="app.css">@end@push('scripts')<script src="app.js"></script>@end Styles: @stack('styles') Scripts: @stack('scripts')`
    const output = await renderOutput(template)
    expect(output).toContain('Styles: <link rel="stylesheet" href="app.css">')
    expect(output).toContain('Scripts: <script src="app.js"></script>')
  })

  test('handles empty push blocks', async () => {
    const template = `@push('scripts')@end@stack('scripts')`
    const output = await renderOutput(template)
    expect(output.trim()).toBe('')
  })
})

// ── @prepend ─────────────────────────────────────────────────────────────────

describe('@prepend', () => {
  test('prepends content to a stack', async () => {
    const template = `@push('scripts')<script>second</script>@end@prepend('scripts')<script>first</script>@end@stack('scripts')`
    const output = await renderOutput(template)
    expect(output.trim()).toBe('<script>first</script><script>second</script>')
  })

  test('multiple prepends stack in reverse order', async () => {
    const template = `@prepend('scripts')<script>middle</script>@end@prepend('scripts')<script>first</script>@end@push('scripts')<script>last</script>@end@stack('scripts')`
    const output = await renderOutput(template)
    expect(output.trim()).toBe('<script>first</script><script>middle</script><script>last</script>')
  })
})

// ── Mixed usage ─────────────────────────────────────────────────────────────

describe('Mixed push/prepend usage', () => {
  test('complex example with multiple operations', async () => {
    const template = `@push('styles')<link rel="stylesheet" href="base.css">@end@prepend('styles')<link rel="stylesheet" href="normalize.css">@end@push('styles')<link rel="stylesheet" href="theme.css">@end@prepend('scripts')<script>window.config = {};</script>@end@push('scripts')<script src="app.js"></script>@end<html><head>@stack('styles')</head><body>@stack('scripts')</body></html>`
    const output = await renderOutput(template)

    // Check styles order: normalize (prepended), base (pushed), theme (pushed)
    expect(output).toContain('<link rel="stylesheet" href="normalize.css"><link rel="stylesheet" href="base.css"><link rel="stylesheet" href="theme.css">')

    // Check scripts order: config (prepended), app (pushed)
    expect(output).toContain('<script>window.config = {};</script><script src="app.js"></script>')
  })
})

// ── Error handling ─────────────────────────────────────────────────────────

describe('Error handling', () => {
  test('throws error for @push without name', async () => {
    expect(async () => {
      await render(`@push() content @end`)
    }).toThrow()
  })

  test('throws error for @prepend without name', async () => {
    expect(async () => {
      await render(`@prepend() content @end`)
    }).toThrow()
  })

  test('throws error for @stack without name', async () => {
    expect(async () => {
      await render(`@stack()`)
    }).toThrow()
  })

  test('throws error for unclosed @push', async () => {
    expect(async () => {
      await render(`@push('test') content`)
    }).toThrow()
  })

  test('throws error for unclosed @prepend', async () => {
    expect(async () => {
      await render(`@prepend('test') content`)
    }).toThrow()
  })
})

// ── Stack return values ─────────────────────────────────────────────────────

describe('Stack return values', () => {
  test('returns stacks in result object', async () => {
    const template = `@push('scripts')<script>test</script>@end@push('styles')<style>body{}</style>@end`
    const result = await render(template)

    expect(result.stacks).toBeDefined()
    expect(result.stacks['scripts']).toEqual(['<script>test</script>'])
    expect(result.stacks['styles']).toEqual(['<style>body{}</style>'])
  })

  test('empty template returns empty stacks', async () => {
    const result = await render('Hello world')
    expect(result.stacks).toEqual({})
  })
})

// ── @include nested inside capturing block directives ────────────────────────

describe('@include nested inside block directives', () => {
  const stubInclude = async (name: string) => `<from:${name}>`

  test('@include works inside @section', async () => {
    const tpl = `@section('content')Hello @include('partial')@end`
    const result = await render(tpl, {}, stubInclude)
    expect(result.blocks['content']).toBe('Hello <from:partial>')
  })

  test('@include works inside @push', async () => {
    const tpl = `@push('scripts')<x>@include('inline')</x>@end@stack('scripts')`
    const result = await render(tpl, {}, stubInclude)
    expect(result.output.trim()).toBe('<x><from:inline></x>')
  })

  test('@include works inside @prepend', async () => {
    const tpl = `@push('s')B@end@prepend('s')A:@include('p')@end@stack('s')`
    const result = await render(tpl, {}, stubInclude)
    expect(result.output.trim()).toBe('A:<from:p>B')
  })

  test('multiple @includes inside a single @section', async () => {
    const tpl = `@section('content')@include('one') and @include('two')@end`
    const result = await render(tpl, {}, stubInclude)
    expect(result.blocks['content']).toBe('<from:one> and <from:two>')
  })
})