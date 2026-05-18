import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import PageController from '../src/pages/page_controller.ts'

// Minimal Configuration mock — PageController only calls config.get('view', {}).
function makeConfig(viewConfig: unknown) {
  return {
    get(key: string, fallback?: unknown) {
      if (key === 'view') return viewConfig
      return fallback
    },
  } as any
}

// Minimal Context — handle() only touches params.path, subdomain and view().
// view() echoes the resolved template path back as the response body so we
// can assert on it.
function makeCtx(path: string, subdomain = '') {
  return {
    params: { path },
    subdomain,
    view: async (template: string) => new Response(template),
  } as any
}

interface SetupOptions {
  groupFolders?: boolean
}

function setup(files: string[], opts: SetupOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'strav-view-groups-'))
  const pagesDir = join(root, 'pages')
  for (const rel of files) {
    const abs = join(pagesDir, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, `template:${rel}`)
  }
  const config = makeConfig({
    directory: root,
    pages: {
      enabled: true,
      directory: 'pages',
      ...(opts.groupFolders === undefined ? {} : { groupFolders: opts.groupFolders }),
    },
  })
  return new PageController(config)
}

async function request(controller: PageController, path: string, subdomain = '') {
  const res = await controller.handle(makeCtx(path, subdomain))
  return { status: res.status, body: await res.text() }
}

describe('PageController route-group folders', () => {
  test('grouped file serves the un-prefixed URL', async () => {
    const c = setup(['(marketing)/contact.strav'])
    const { status, body } = await request(c, 'contact')
    expect(status).toBe(200)
    expect(body).toBe('pages/(marketing)/contact')
  })

  test('nested groups are all transparent', async () => {
    const c = setup(['(a)/(b)/x.strav'])
    const { status, body } = await request(c, 'x')
    expect(status).toBe(200)
    expect(body).toBe('pages/(a)/(b)/x')
  })

  test('group index resolves the root URL', async () => {
    const c = setup(['(marketing)/index.strav'])
    const { status, body } = await request(c, '')
    expect(status).toBe(200)
    expect(body).toBe('pages/(marketing)/index')
  })

  test('direct (non-group) match wins over a grouped one', async () => {
    const c = setup(['contact.strav', '(marketing)/contact.strav'])
    const { body } = await request(c, 'contact')
    expect(body).toBe('pages/contact')
  })

  test('group folder works mid-tree', async () => {
    const c = setup(['blog/(internal)/draft.strav'])
    const { status, body } = await request(c, 'blog/draft')
    expect(status).toBe(200)
    expect(body).toBe('pages/blog/(internal)/draft')
  })

  test('trailing slash forces an index, not a sibling file', async () => {
    const c = setup(['(g)/about.strav', '(g)/about/index.strav'])
    const { body } = await request(c, 'about/')
    expect(body).toBe('pages/(g)/about/index')
  })

  test('unknown path 404s', async () => {
    const c = setup(['(marketing)/contact.strav'])
    const { status } = await request(c, 'nope')
    expect(status).toBe(404)
  })

  test('groupFolders:false restores legacy behavior (grouped path 404s)', async () => {
    const c = setup(['(marketing)/contact.strav'], { groupFolders: false })
    const { status } = await request(c, 'contact')
    expect(status).toBe(404)
  })

  test('regression: existing non-group routes still resolve', async () => {
    const c = setup(['index.strav', 'about.strav', 'team/members.strav', 'docs/index.strav'])
    expect((await request(c, '')).body).toBe('pages/index')
    expect((await request(c, 'about')).body).toBe('pages/about')
    expect((await request(c, 'team/members')).body).toBe('pages/team/members')
    expect((await request(c, 'docs')).body).toBe('pages/docs/index')
  })
})
