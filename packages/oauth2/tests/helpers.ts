import { Context } from '@strav/http'
import OAuth2Manager from '../src/oauth2_manager.ts'
import ScopeRegistry from '../src/scopes.ts'
import type { OAuth2Actions, OAuth2Config } from '../src/types.ts'

// ---------------------------------------------------------------------------
// Mock user
// ---------------------------------------------------------------------------

export interface MockUser {
  id: number
  email: string
  name: string
}

let userStore: MockUser[] = []
let nextUserId = 1

export function resetUserStore() {
  userStore = []
  nextUserId = 1
}

export function createMockUser(overrides: Partial<MockUser> = {}): MockUser {
  const user: MockUser = {
    id: nextUserId++,
    email: 'user@example.com',
    name: 'Test User',
    ...overrides,
  }
  userStore.push(user)
  return user
}

// ---------------------------------------------------------------------------
// Mock actions
// ---------------------------------------------------------------------------

export function mockActions(): OAuth2Actions<MockUser> {
  return {
    findById: async id => userStore.find(u => u.id === Number(id)) ?? null,
    identifierOf: user => user.email,
  }
}

// ---------------------------------------------------------------------------
// Mock database (in-memory stores)
// ---------------------------------------------------------------------------

interface ClientRow {
  id: string
  name: string
  secret: string | null
  redirect_uris: string[]
  scopes: string[] | null
  grant_types: string[]
  confidential: boolean
  first_party: boolean
  revoked: boolean
  created_at: Date
  updated_at: Date
}

interface TokenRow {
  id: string
  user_id: string | null
  client_id: string
  name: string | null
  scopes: string[]
  token: string
  refresh_token: string | null
  expires_at: Date
  refresh_expires_at: Date | null
  last_used_at: Date | null
  revoked_at: Date | null
  created_at: Date
}

interface AuthCodeRow {
  id: string
  client_id: string
  user_id: string
  code: string
  redirect_uri: string
  scopes: string[]
  code_challenge: string | null
  code_challenge_method: string | null
  expires_at: Date
  used_at: Date | null
  created_at: Date
}

let clientStore: ClientRow[] = []
let tokenStore: TokenRow[] = []
let authCodeStore: AuthCodeRow[] = []
let nextUuid = 1

function genUuid(): string {
  return `uuid-${nextUuid++}`
}

export function resetStores() {
  clientStore = []
  tokenStore = []
  authCodeStore = []
  nextUuid = 1
}

export function getClientStore() {
  return clientStore
}
export function getTokenStore() {
  return tokenStore
}
export function getAuthCodeStore() {
  return authCodeStore
}

/**
 * Create a mock SQL tagged template that interprets queries and operates
 * on in-memory stores. Captures the interpolated values from the template.
 */
function createMockSql() {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): any => {
    const query = strings.join('$').toLowerCase().trim()

    // ── CREATE TABLE / CREATE INDEX (DDL) ─────────────────────────────
    if (query.startsWith('create table') || query.startsWith('create index')) {
      const result: any = []
      result.count = 0
      return Promise.resolve(result)
    }

    // ── INSERT INTO _strav_oauth_clients ───────────────────────────────
    if (query.includes('_strav_oauth_clients') && query.includes('insert')) {
      const row: ClientRow = {
        id: genUuid(),
        name: values[0] as string,
        secret: values[1] as string | null,
        redirect_uris: JSON.parse(values[2] as string),
        scopes: values[3] !== null ? JSON.parse(values[3] as string) : null,
        grant_types: JSON.parse(values[4] as string),
        confidential: values[5] as boolean,
        first_party: values[6] as boolean,
        revoked: values[7] as boolean,
        created_at: new Date(),
        updated_at: new Date(),
      }
      clientStore.push(row)
      const result: any = [row]
      result.count = 1
      return Promise.resolve(result)
    }

    // ── SELECT "secret" FROM _strav_oauth_clients ─────────────────────
    if (
      query.includes('_strav_oauth_clients') &&
      query.includes('select') &&
      query.includes('"secret"') &&
      !query.includes('"name"')
    ) {
      const id = values[0] as string
      const found = clientStore.find(c => c.id === id)
      const result: any = found ? [{ secret: found.secret }] : []
      result.count = result.length
      return Promise.resolve(result)
    }

    // ── SELECT * FROM _strav_oauth_clients WHERE "id" ─────────────────
    if (
      query.includes('_strav_oauth_clients') &&
      query.includes('select') &&
      query.includes('"id"')
    ) {
      const id = values[0] as string
      const found = clientStore.find(c => c.id === id)
      const result: any = found ? [found] : []
      result.count = result.length
      return Promise.resolve(result)
    }

    // ── SELECT * FROM _strav_oauth_clients WHERE "revoked" ────────────
    if (
      query.includes('_strav_oauth_clients') &&
      query.includes('select') &&
      query.includes('"revoked"')
    ) {
      const result: any = clientStore.filter(c => !c.revoked)
      result.count = result.length
      return Promise.resolve(result)
    }

    // ── UPDATE _strav_oauth_clients SET "revoked" ─────────────────────
    if (
      query.includes('_strav_oauth_clients') &&
      query.includes('update') &&
      query.includes('"revoked"')
    ) {
      const id = values[0] as string
      const found = clientStore.find(c => c.id === id)
      if (found) {
        found.revoked = true
        found.updated_at = new Date()
      }
      const result: any = []
      result.count = found ? 1 : 0
      return Promise.resolve(result)
    }

    // ── DELETE FROM _strav_oauth_clients ───────────────────────────────
    if (query.includes('delete') && query.includes('_strav_oauth_clients')) {
      const id = values[0] as string
      const idx = clientStore.findIndex(c => c.id === id)
      if (idx >= 0) clientStore.splice(idx, 1)
      const result: any = []
      result.count = idx >= 0 ? 1 : 0
      return Promise.resolve(result)
    }

    // ── INSERT INTO _strav_oauth_tokens ────────────────────────────────
    if (query.includes('_strav_oauth_tokens') && query.includes('insert')) {
      const row: TokenRow = {
        id: genUuid(),
        user_id: values[0] as string | null,
        client_id: values[1] as string,
        name: values[2] as string | null,
        scopes: JSON.parse(values[3] as string),
        token: values[4] as string,
        refresh_token: values[5] as string | null,
        expires_at: values[6] as Date,
        refresh_expires_at: values[7] as Date | null,
        last_used_at: null,
        revoked_at: null,
        created_at: new Date(),
      }
      tokenStore.push(row)
      const result: any = [row]
      result.count = 1
      return Promise.resolve(result)
    }

    // ── SELECT * FROM _strav_oauth_tokens WHERE "token" ───────────────
    if (
      query.includes('_strav_oauth_tokens') &&
      query.includes('select') &&
      query.includes('"token"') &&
      !query.includes('"refresh_token"')
    ) {
      const hash = values[0] as string
      const found = tokenStore.find(t => t.token === hash)
      const result: any = found ? [found] : []
      result.count = result.length
      return Promise.resolve(result)
    }

    // ── SELECT * FROM _strav_oauth_tokens WHERE "refresh_token" ───────
    if (
      query.includes('_strav_oauth_tokens') &&
      query.includes('select') &&
      query.includes('"refresh_token"')
    ) {
      const hash = values[0] as string
      const found = tokenStore.find(t => t.refresh_token === hash)
      const result: any = found ? [found] : []
      result.count = result.length
      return Promise.resolve(result)
    }

    // ── UPDATE _strav_oauth_tokens SET "last_used_at" ─────────────────
    if (
      query.includes('_strav_oauth_tokens') &&
      query.includes('update') &&
      query.includes('"last_used_at"') &&
      !query.includes('"revoked_at"')
    ) {
      const id = values[0] as string
      const found = tokenStore.find(t => t.id === id)
      if (found) found.last_used_at = new Date()
      const result: any = []
      result.count = found ? 1 : 0
      return Promise.resolve(result)
    }

    // ── UPDATE _strav_oauth_tokens SET "revoked_at" WHERE "id" ────────
    if (
      query.includes('_strav_oauth_tokens') &&
      query.includes('update') &&
      query.includes('"revoked_at"') &&
      query.includes('"id"')
    ) {
      const id = values[0] as string
      const found = tokenStore.find(t => t.id === id)
      if (found) found.revoked_at = new Date()
      const result: any = []
      result.count = found ? 1 : 0
      return Promise.resolve(result)
    }

    // ── UPDATE _strav_oauth_tokens SET "revoked_at" WHERE "user_id" AND "client_id" ──
    if (
      query.includes('_strav_oauth_tokens') &&
      query.includes('update') &&
      query.includes('"revoked_at"') &&
      query.includes('"user_id"') &&
      query.includes('"client_id"')
    ) {
      const userId = values[0] as string
      const clientId = values[1] as string
      let count = 0
      for (const t of tokenStore) {
        if (t.user_id === userId && t.client_id === clientId && !t.revoked_at) {
          t.revoked_at = new Date()
          count++
        }
      }
      const result: any = []
      result.count = count
      return Promise.resolve(result)
    }

    // ── UPDATE _strav_oauth_tokens SET "revoked_at" WHERE "user_id" ───
    if (
      query.includes('_strav_oauth_tokens') &&
      query.includes('update') &&
      query.includes('"revoked_at"') &&
      query.includes('"user_id"')
    ) {
      const userId = values[0] as string
      let count = 0
      for (const t of tokenStore) {
        if (t.user_id === userId && !t.revoked_at) {
          t.revoked_at = new Date()
          count++
        }
      }
      const result: any = []
      result.count = count
      return Promise.resolve(result)
    }

    // ── SELECT * FROM _strav_oauth_tokens WHERE "user_id" AND "client_id" (personal tokens) ──
    if (
      query.includes('_strav_oauth_tokens') &&
      query.includes('select') &&
      query.includes('"user_id"') &&
      query.includes('"client_id"')
    ) {
      const userId = values[0] as string
      const clientId = values[1] as string
      const result: any = tokenStore.filter(
        t =>
          t.user_id === userId &&
          t.client_id === clientId &&
          !t.revoked_at &&
          t.expires_at.getTime() > Date.now()
      )
      result.count = result.length
      return Promise.resolve(result)
    }

    // ── SELECT * FROM _strav_oauth_tokens WHERE "user_id" ─────────────
    if (
      query.includes('_strav_oauth_tokens') &&
      query.includes('select') &&
      query.includes('"user_id"')
    ) {
      const userId = values[0] as string
      const result: any = tokenStore.filter(
        t => t.user_id === userId && !t.revoked_at && t.expires_at.getTime() > Date.now()
      )
      result.count = result.length
      return Promise.resolve(result)
    }

    // ── DELETE FROM _strav_oauth_tokens ────────────────────────────────
    if (query.includes('delete') && query.includes('_strav_oauth_tokens')) {
      // Prune: delete expired/revoked tokens
      const before = tokenStore.length
      tokenStore = tokenStore.filter(t => {
        // Keep if not expired and not revoked
        const expired = t.expires_at.getTime() < Date.now() && !t.refresh_expires_at
        const refreshExpired = t.refresh_expires_at && t.refresh_expires_at.getTime() < Date.now()
        const oldRevoked = t.revoked_at && t.revoked_at.getTime() < (values[0] as Date)?.getTime?.()
        return !expired && !refreshExpired && !oldRevoked
      })
      const result: any = []
      result.count = before - tokenStore.length
      return Promise.resolve(result)
    }

    // ── INSERT INTO _strav_oauth_auth_codes ────────────────────────────
    if (query.includes('_strav_oauth_auth_codes') && query.includes('insert')) {
      const row: AuthCodeRow = {
        id: genUuid(),
        client_id: values[0] as string,
        user_id: values[1] as string,
        code: values[2] as string,
        redirect_uri: values[3] as string,
        scopes: JSON.parse(values[4] as string),
        code_challenge: values[5] as string | null,
        code_challenge_method: values[6] as string | null,
        expires_at: values[7] as Date,
        used_at: null,
        created_at: new Date(),
      }
      authCodeStore.push(row)
      const result: any = [row]
      result.count = 1
      return Promise.resolve(result)
    }

    // ── SELECT * FROM _strav_oauth_auth_codes ──────────────────────────
    if (query.includes('_strav_oauth_auth_codes') && query.includes('select')) {
      const code = values[0] as string
      const clientId = values[1] as string
      const found = authCodeStore.find(c => c.code === code && c.client_id === clientId)
      const result: any = found ? [found] : []
      result.count = result.length
      return Promise.resolve(result)
    }

    // ── UPDATE _strav_oauth_auth_codes SET "used_at" RETURNING * ───────
    if (query.includes('_strav_oauth_auth_codes') && query.includes('update')) {
      // New atomic consume signature: WHERE code = $1 AND client_id = $2 AND used_at IS NULL
      const code = values[0] as string
      const clientId = values[1] as string
      const found = authCodeStore.find(
        c => c.code === code && c.client_id === clientId && c.used_at === null
      )
      if (!found) {
        const empty: any = []
        empty.count = 0
        return Promise.resolve(empty)
      }
      found.used_at = new Date()
      const result: any = [found]
      result.count = 1
      return Promise.resolve(result)
    }

    // ── DELETE FROM _strav_oauth_auth_codes ────────────────────────────
    if (query.includes('delete') && query.includes('_strav_oauth_auth_codes')) {
      const before = authCodeStore.length
      authCodeStore = authCodeStore.filter(c => {
        return c.expires_at.getTime() >= Date.now() && !c.used_at
      })
      const result: any = []
      result.count = before - authCodeStore.length
      return Promise.resolve(result)
    }

    // ── Fallback ──────────────────────────────────────────────────────
    const result: any = []
    result.count = 0
    return Promise.resolve(result)
  }

  return sql
}

// ---------------------------------------------------------------------------
// Mock configuration
// ---------------------------------------------------------------------------

export function mockConfig(overrides: Partial<OAuth2Config> = {}): any {
  const data: Record<string, unknown> = {
    oauth2: {
      accessTokenLifetime: 60,
      refreshTokenLifetime: 43_200,
      authCodeLifetime: 10,
      personalAccessTokenLifetime: 525_600,
      prefix: '/oauth',
      scopes: {},
      defaultScopes: [],
      personalAccessClient: null,
      rateLimit: {
        authorize: { max: 30, window: 60 },
        token: { max: 20, window: 60 },
      },
      pruneRevokedAfterDays: 7,
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
  }
}

// ---------------------------------------------------------------------------
// Boot OAuth2Manager with mocks
// ---------------------------------------------------------------------------

export function bootOAuth2(overrides: Partial<OAuth2Config> = {}) {
  const config = mockConfig(overrides)
  const db = { sql: createMockSql() } as any

  OAuth2Manager.reset()
  // Set the static fields directly since we can't go through DI
  ;(OAuth2Manager as any)._db = db
  ;(OAuth2Manager as any)._config = {
    accessTokenLifetime: 60,
    refreshTokenLifetime: 43_200,
    authCodeLifetime: 10,
    personalAccessTokenLifetime: 525_600,
    prefix: '/oauth',
    scopes: {},
    defaultScopes: [],
    personalAccessClient: null,
    rateLimit: {
      authorize: { max: 30, window: 60 },
      token: { max: 20, window: 60 },
    },
    pruneRevokedAfterDays: 7,
    ...overrides,
  }
  OAuth2Manager.useActions(mockActions())

  if (overrides.scopes) {
    ScopeRegistry.define(overrides.scopes)
  }
}

// ---------------------------------------------------------------------------
// Mock Context
// ---------------------------------------------------------------------------

export function mockContext(
  options: {
    method?: string
    path?: string
    body?: unknown
    params?: Record<string, string>
    headers?: Record<string, string>
    query?: Record<string, string>
  } = {}
): Context {
  const { method = 'GET', path = '/', body, params = {}, headers = {}, query } = options

  let url = `http://localhost${path}`
  if (query) {
    const qs = new URLSearchParams(query).toString()
    url += `?${qs}`
  }

  const requestInit: RequestInit = { method, headers }

  if (body && method !== 'GET') {
    requestInit.body = JSON.stringify(body)
    ;(requestInit.headers as Record<string, string>)['content-type'] = 'application/json'
  }

  const request = new Request(url, requestInit)
  return new Context(request, params)
}

// ---------------------------------------------------------------------------
// Mock Session
// ---------------------------------------------------------------------------

export class MockSession {
  private _data = new Map<string, unknown>()

  get<T = unknown>(key: string, defaultValue?: T): T {
    return (this._data.get(key) as T) ?? (defaultValue as T)
  }

  set(key: string, value: unknown): void {
    this._data.set(key, value)
  }

  has(key: string): boolean {
    return this._data.has(key)
  }

  forget(key: string): void {
    this._data.delete(key)
  }
}

/** Create a context with a mock session attached. */
export function mockContextWithSession(options: Parameters<typeof mockContext>[0] = {}) {
  const ctx = mockContext(options)
  const session = new MockSession()
  ctx.set('session', session)
  return { ctx, session }
}

/** Create a context with an authenticated user and session. */
export function mockAuthenticatedContext(
  user: MockUser,
  options: Parameters<typeof mockContext>[0] = {}
) {
  const { ctx, session } = mockContextWithSession(options)
  ctx.set('user', user)
  return { ctx, session }
}
