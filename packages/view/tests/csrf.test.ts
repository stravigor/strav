import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { tokenize } from '../src/tokenizer.ts'
import { compile } from '../src/compiler.ts'
import { escapeHtml } from '../src/escape.ts'

async function render(template: string, data: Record<string, unknown> = {}): Promise<string> {
  const tokens = tokenize(template)
  const result = compile(tokens)
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const fn = new AsyncFunction(
    '__data',
    '__escape',
    '__include',
    `with (__data) {\n${result.code}\n}`
  )
  const output = await fn(data, escapeHtml, () => '')
  return output.output
}

describe('@csrf directive', () => {
  test('@csrf renders the bare escaped token value', async () => {
    const html = await render(`@csrf`, { csrfToken: 'a1b2c3' })
    expect(html).toBe('a1b2c3')
  })

  test('@csrf() renders the bare escaped token value', async () => {
    const html = await render(`@csrf()`, { csrfToken: 'a1b2c3' })
    expect(html).toBe('a1b2c3')
  })

  test("@csrf('input') renders the hidden form input", async () => {
    const html = await render(
      `<form>@csrf('input')<input name="title"></form>`,
      { csrfToken: 'a1b2c3' }
    )
    expect(html).toBe(
      `<form><input type="hidden" name="_token" value="a1b2c3"><input name="title"></form>`
    )
  })

  test('@csrf("input") accepts double-quoted argument', async () => {
    const html = await render(`@csrf("input")`, { csrfToken: 'a1b2c3' })
    expect(html).toBe(`<input type="hidden" name="_token" value="a1b2c3">`)
  })

  test("@csrf('meta') renders the meta tag", async () => {
    const html = await render(
      `<head><title>App</title>@csrf('meta')</head>`,
      { csrfToken: 'a1b2c3' }
    )
    expect(html).toBe(`<head><title>App</title><meta name="csrf" content="a1b2c3"></head>`)
  })

  test('escapes the token value in every form', async () => {
    const evil = '<x>"&\''
    const expectedEscaped = '&lt;x&gt;&quot;&amp;&#39;'

    expect(await render(`@csrf`, { csrfToken: evil })).toBe(expectedEscaped)
    expect(await render(`@csrf('input')`, { csrfToken: evil })).toBe(
      `<input type="hidden" name="_token" value="${expectedEscaped}">`
    )
    expect(await render(`@csrf('meta')`, { csrfToken: evil })).toBe(
      `<meta name="csrf" content="${expectedEscaped}">`
    )
  })

  test('throws TemplateError on unknown variant', async () => {
    await expect(render(`@csrf('header')`, { csrfToken: 'tok' })).rejects.toThrow(
      /@csrf accepts 'meta' or 'input'/
    )
  })
})

// ── xfetch — runtime CSRF injection ────────────────────────────────────────

describe('xfetch', () => {
  let originalFetch: typeof globalThis.fetch
  let originalDocument: unknown
  let lastInit: RequestInit | undefined

  beforeEach(() => {
    originalFetch = globalThis.fetch
    originalDocument = (globalThis as any).document

    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      lastInit = init
      return new Response(null, { status: 200 })
    }) as typeof globalThis.fetch

    ;(globalThis as any).document = {
      querySelector(selector: string) {
        if (selector === 'meta[name="csrf"]') return { content: 'sess-token' }
        return null
      },
    }
  })

  afterEach(async () => {
    globalThis.fetch = originalFetch
    ;(globalThis as any).document = originalDocument
    lastInit = undefined
    const { resetCsrfTokenCache } = await import('../src/client/xfetch.ts')
    resetCsrfTokenCache()
  })

  test('injects X-CSRF-Token on POST', async () => {
    const { xfetch } = await import('../src/client/xfetch.ts')
    await xfetch('/api/projects', { method: 'POST' })

    const headers = new Headers(lastInit?.headers)
    expect(headers.get('X-CSRF-Token')).toBe('sess-token')
    expect(lastInit?.credentials).toBe('same-origin')
  })

  test('injects on PUT, PATCH, DELETE', async () => {
    const { xfetch } = await import('../src/client/xfetch.ts')
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      await xfetch('/api/x', { method })
      const headers = new Headers(lastInit?.headers)
      expect(headers.get('X-CSRF-Token')).toBe('sess-token')
    }
  })

  test('does not inject on GET', async () => {
    const { xfetch } = await import('../src/client/xfetch.ts')
    await xfetch('/api/projects')
    const headers = new Headers(lastInit?.headers)
    expect(headers.get('X-CSRF-Token')).toBeNull()
  })

  test('preserves a user-set X-CSRF-Token header', async () => {
    const { xfetch } = await import('../src/client/xfetch.ts')
    await xfetch('/api/projects', {
      method: 'POST',
      headers: { 'X-CSRF-Token': 'user-set' },
    })
    const headers = new Headers(lastInit?.headers)
    expect(headers.get('X-CSRF-Token')).toBe('user-set')
  })

  test('preserves user-set credentials', async () => {
    const { xfetch } = await import('../src/client/xfetch.ts')
    await xfetch('/api/projects', { method: 'POST', credentials: 'include' })
    expect(lastInit?.credentials).toBe('include')
  })

  test('passes through other RequestInit fields untouched', async () => {
    const { xfetch } = await import('../src/client/xfetch.ts')
    const body = JSON.stringify({ name: 'Foo' })
    await xfetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    expect(lastInit?.body).toBe(body)
    const headers = new Headers(lastInit?.headers)
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('X-CSRF-Token')).toBe('sess-token')
  })

  test('skips the header when no meta tag is present', async () => {
    ;(globalThis as any).document = { querySelector: () => null }
    const { xfetch, resetCsrfTokenCache } = await import('../src/client/xfetch.ts')
    resetCsrfTokenCache()
    await xfetch('/api/projects', { method: 'POST' })
    const headers = new Headers(lastInit?.headers)
    expect(headers.get('X-CSRF-Token')).toBeNull()
  })
})
