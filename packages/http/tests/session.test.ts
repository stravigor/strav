import { describe, test, expect } from 'bun:test'
import { Context } from '../src/http/index.ts'
import { session } from '../src/session/middleware.ts'
import Session from '../src/session/session.ts'
import SessionManager from '../src/session/session_manager.ts'
import type { SessionConfig } from '../src/session/session_manager.ts'
import type { SessionRecord, SessionStore } from '@strav/kernel/session/session_store'

/** Minimal in-memory store so the middleware can save/load without a database. */
class MemoryStore implements SessionStore {
  rows = new Map<string, SessionRecord>()
  async find(id: string) {
    return this.rows.get(id) ?? null
  }
  async save(record: SessionRecord) {
    this.rows.set(record.id, record)
  }
  async destroy(id: string) {
    this.rows.delete(id)
  }
  async touch() {}
  async gc() {
    return 0
  }
}

/** Reset SessionManager with the given config overrides + a fresh memory store. */
function configure(overrides: Partial<SessionConfig> = {}): void {
  const fakeConfig = { get: () => overrides }
  new SessionManager(fakeConfig as never)
  SessionManager.useStore(new MemoryStore())
}

function sessionCookie(res: Response): string | undefined {
  return res.headers.getSetCookie().find((c) => c.startsWith('strav_session='))
}

const next = async () => new Response('ok', { status: 200 })

describe('session() cookie domain', () => {
  test('omits Domain when config.domain is unset (host-only — default)', async () => {
    configure()
    const ctx = new Context(new Request('http://app.example.com/'))

    const res = await session()(ctx, next)

    const cookie = sessionCookie(res)
    expect(cookie).toBeDefined()
    expect(cookie).not.toContain('Domain=')
  })

  test('emits Domain when config.domain is set (cross-subdomain)', async () => {
    configure({ domain: '.example.com' })
    const ctx = new Context(new Request('http://app.example.com/'))

    const res = await session()(ctx, next)

    expect(sessionCookie(res)).toContain('Domain=.example.com')
  })

  test('Session.destroy clears the cookie scoped to the configured Domain', async () => {
    configure({ domain: '.example.com' })
    const ctx = new Context(
      new Request('http://app.example.com/', { headers: { cookie: 'strav_session=abc' } })
    )

    const res = await Session.destroy(ctx, new Response('bye'))

    const cookie = sessionCookie(res)
    expect(cookie).toContain('Domain=.example.com')
    expect(cookie).toContain('Max-Age=0')
  })

  test('Session.destroy stays host-only when config.domain is unset', async () => {
    configure()
    const ctx = new Context(
      new Request('http://app.example.com/', { headers: { cookie: 'strav_session=abc' } })
    )

    const res = await Session.destroy(ctx, new Response('bye'))

    expect(sessionCookie(res)).not.toContain('Domain=')
  })
})
