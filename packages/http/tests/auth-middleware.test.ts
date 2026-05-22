import { describe, test, expect, beforeAll, afterEach } from 'bun:test'
import { Context } from '../src/http/index.ts'
import { auth } from '../src/auth/middleware/authenticate.ts'
import Auth from '../src/auth/auth.ts'
import AccessToken from '../src/auth/access_token.ts'

// Configure Auth's static state for tests: default guard ('session') comes
// from the fake config's fallback value; the user resolver is set per test.
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  new (Auth as any)({}, { get: (_key: string, fallback: unknown) => fallback })
})

interface FakeSession {
  isAuthenticated: boolean
  userId: string | null
  isExpired: () => boolean
  touch: () => Promise<void>
}

function makeSession(overrides: Partial<FakeSession> = {}): FakeSession {
  return {
    isAuthenticated: true,
    userId: 'u1',
    isExpired: () => false,
    touch: async () => {},
    ...overrides,
  }
}

function ctxWith(session?: FakeSession, init?: RequestInit): Context {
  const ctx = new Context(new Request('http://example.com/me', init))
  if (session) ctx.set('session', session)
  return ctx
}

const next = async () => new Response('ok', { status: 200 })

describe('auth() — default failure body', () => {
  test('session guard: no session → { error: "Unauthenticated" } 401', async () => {
    const res = await auth('session')(ctxWith(), next)

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthenticated' })
  })

  test('session guard: unauthenticated session → 401', async () => {
    const res = await auth('session')(ctxWith(makeSession({ isAuthenticated: false })), next)

    expect(res.status).toBe(401)
  })

  test('session guard: expired session → 401', async () => {
    const res = await auth('session')(ctxWith(makeSession({ isExpired: () => true })), next)

    expect(res.status).toBe(401)
  })

  test('token guard: no bearer header → { error: "Unauthenticated" } 401', async () => {
    const res = await auth('token')(ctxWith(), next)

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthenticated' })
  })
})

describe('auth("session", { onFail })', () => {
  test('onFail shapes the failure response', async () => {
    const res = await auth('session', {
      onFail: (c, reason) =>
        c.json({ error_code: 'UNAUTHORIZED', message: reason, details: null }, 401),
    })(ctxWith(), next)

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({
      error_code: 'UNAUTHORIZED',
      message: 'no-session',
      details: null,
    })
  })

  test('reports reason "no-session" when no session exists', async () => {
    let seen: string | undefined
    await auth('session', {
      onFail: (c, reason) => {
        seen = reason
        return c.json({}, 401)
      },
    })(ctxWith(), next)

    expect(seen).toBe('no-session')
  })

  test('reports reason "unauthenticated" for an unauthenticated session', async () => {
    let seen: string | undefined
    await auth('session', {
      onFail: (c, reason) => {
        seen = reason
        return c.json({}, 401)
      },
    })(ctxWith(makeSession({ isAuthenticated: false })), next)

    expect(seen).toBe('unauthenticated')
  })

  test('reports reason "session-expired" for an expired session', async () => {
    let seen: string | undefined
    await auth('session', {
      onFail: (c, reason) => {
        seen = reason
        return c.json({}, 401)
      },
    })(ctxWith(makeSession({ isExpired: () => true })), next)

    expect(seen).toBe('session-expired')
  })

  test('reports reason "user-not-found" when the resolver returns null', async () => {
    Auth.useResolver(async () => null)
    let seen: string | undefined
    await auth('session', {
      onFail: (c, reason) => {
        seen = reason
        return c.json({}, 401)
      },
    })(ctxWith(makeSession()), next)

    expect(seen).toBe('user-not-found')
  })

  test('supports an async onFail', async () => {
    const res = await auth('session', {
      onFail: async (c) => c.json({ error_code: 'ASYNC' }, 401),
    })(ctxWith(), next)

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error_code: 'ASYNC' })
  })

  test('a valid request still passes with onFail set', async () => {
    Auth.useResolver(async () => ({ id: 'u1' }))
    let touched = false
    const session = makeSession({
      touch: async () => {
        touched = true
      },
    })

    const res = await auth('session', { onFail: (c) => c.json({}, 401) })(ctxWith(session), next)

    expect(res.status).toBe(200)
    expect(touched).toBe(true)
  })
})

describe('auth("token", { onFail })', () => {
  const realValidate = AccessToken.validate
  afterEach(() => {
    AccessToken.validate = realValidate
  })

  test('reports reason "no-token" when no Authorization header is sent', async () => {
    let seen: string | undefined
    await auth('token', {
      onFail: (c, reason) => {
        seen = reason
        return c.json({}, 401)
      },
    })(ctxWith(), next)

    expect(seen).toBe('no-token')
  })

  test('reports reason "invalid-token" when the bearer token does not validate', async () => {
    AccessToken.validate = async () => null
    let seen: string | undefined
    await auth('token', {
      onFail: (c, reason) => {
        seen = reason
        return c.json({}, 401)
      },
    })(ctxWith(undefined, { headers: { authorization: 'Bearer bogus' } }), next)

    expect(seen).toBe('invalid-token')
  })

  test('reports reason "user-not-found" when the token resolves no user', async () => {
    AccessToken.validate = async () =>
      ({ id: 1, userId: 'u1', name: 't', lastUsedAt: null, expiresAt: null, createdAt: new Date() })
    Auth.useResolver(async () => null)
    let seen: string | undefined
    await auth('token', {
      onFail: (c, reason) => {
        seen = reason
        return c.json({}, 401)
      },
    })(ctxWith(undefined, { headers: { authorization: 'Bearer good' } }), next)

    expect(seen).toBe('user-not-found')
  })
})

describe('auth({ onFail }) — union signature', () => {
  test('a lone options object shapes the default-guard failure', async () => {
    let seen: string | undefined
    const res = await auth({
      onFail: (c, reason) => {
        seen = reason
        return c.json({ error_code: 'UNAUTHORIZED' }, 401)
      },
    })(ctxWith(), next)

    expect(res.status).toBe(401)
    expect(seen).toBe('no-session')
    expect(await res.json()).toEqual({ error_code: 'UNAUTHORIZED' })
  })
})
