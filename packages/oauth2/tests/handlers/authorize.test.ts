import { test, expect, describe, beforeEach } from 'bun:test'
import {
  bootOAuth2,
  resetStores,
  resetUserStore,
  createMockUser,
  mockContext,
  mockAuthenticatedContext,
  MockSession,
} from '../helpers.ts'
import OAuthClient from '../../src/client.ts'
import ScopeRegistry from '../../src/scopes.ts'
import { authorizeHandler, approveHandler } from '../../src/handlers/authorize.ts'

beforeEach(() => {
  resetStores()
  resetUserStore()
  bootOAuth2({ scopes: { read: 'Read', write: 'Write' } })
})

describe('authorizeHandler (GET /oauth/authorize)', () => {
  async function createTestClient(overrides = {}) {
    const { client } = await OAuthClient.create({
      name: 'Test App',
      redirectUris: ['https://example.com/callback'],
      firstParty: false,
      ...overrides,
    })
    return client
  }

  test('rejects missing response_type', async () => {
    const client = await createTestClient()
    const user = createMockUser()
    const { ctx } = mockAuthenticatedContext(user, {
      path: '/oauth/authorize',
      query: { client_id: client.id, redirect_uri: 'https://example.com/callback' },
    })

    const res = await authorizeHandler(ctx)
    expect(res.status).toBe(400)

    const body = await res.json()
    expect(body.error).toBe('invalid_request')
  })

  test('rejects invalid response_type', async () => {
    const client = await createTestClient()
    const user = createMockUser()
    const { ctx } = mockAuthenticatedContext(user, {
      path: '/oauth/authorize',
      query: {
        response_type: 'token',
        client_id: client.id,
        redirect_uri: 'https://example.com/callback',
      },
    })

    const res = await authorizeHandler(ctx)
    expect(res.status).toBe(400)
  })

  test('rejects missing client_id', async () => {
    const user = createMockUser()
    const { ctx } = mockAuthenticatedContext(user, {
      path: '/oauth/authorize',
      query: { response_type: 'code' },
    })

    const res = await authorizeHandler(ctx)
    expect(res.status).toBe(400)

    const body = await res.json()
    expect(body.error).toBe('invalid_request')
  })

  test('rejects non-existent client', async () => {
    const user = createMockUser()
    const { ctx } = mockAuthenticatedContext(user, {
      path: '/oauth/authorize',
      query: {
        response_type: 'code',
        client_id: 'non-existent',
        redirect_uri: 'https://example.com/callback',
      },
    })

    const res = await authorizeHandler(ctx)
    expect(res.status).toBe(401)

    const body = await res.json()
    expect(body.error).toBe('invalid_client')
  })

  test('rejects unregistered redirect_uri', async () => {
    const client = await createTestClient()
    const user = createMockUser()
    const { ctx } = mockAuthenticatedContext(user, {
      path: '/oauth/authorize',
      query: {
        response_type: 'code',
        client_id: client.id,
        redirect_uri: 'https://evil.com/callback',
      },
    })

    const res = await authorizeHandler(ctx)
    expect(res.status).toBe(400)
  })

  test('auto-approves first-party client and redirects with code', async () => {
    const client = await createTestClient({ firstParty: true })
    const user = createMockUser()
    const { ctx } = mockAuthenticatedContext(user, {
      path: '/oauth/authorize',
      query: {
        response_type: 'code',
        client_id: client.id,
        redirect_uri: 'https://example.com/callback',
        scope: 'read',
        state: 'xyz',
      },
    })

    const res = await authorizeHandler(ctx)
    // Should be a redirect
    expect(res.status).toBe(302)

    const location = res.headers.get('location')!
    const url = new URL(location)
    expect(url.origin + url.pathname).toBe('https://example.com/callback')
    expect(url.searchParams.get('code')).toBeDefined()
    expect(url.searchParams.get('state')).toBe('xyz')
  })

  test('returns authorization_required JSON for third-party client (no renderAuthorization)', async () => {
    const client = await createTestClient({ firstParty: false })
    const user = createMockUser()
    const { ctx } = mockAuthenticatedContext(user, {
      path: '/oauth/authorize',
      query: {
        response_type: 'code',
        client_id: client.id,
        redirect_uri: 'https://example.com/callback',
        scope: 'read',
      },
    })

    const res = await authorizeHandler(ctx)
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body.authorization_required).toBe(true)
    expect(body.client.id).toBe(client.id)
    expect(body.client.name).toBe('Test App')
    expect(body.scopes).toHaveLength(1)
    expect(body.scopes[0].name).toBe('read')
  })

  test('stores auth request in session', async () => {
    const client = await createTestClient({ firstParty: false })
    const user = createMockUser()
    const { ctx, session } = mockAuthenticatedContext(user, {
      path: '/oauth/authorize',
      query: {
        response_type: 'code',
        client_id: client.id,
        redirect_uri: 'https://example.com/callback',
        scope: 'read write',
        state: 'abc',
      },
    })

    await authorizeHandler(ctx)

    const authRequest = session.get('_oauth2_auth_request') as any
    expect(authRequest).toBeDefined()
    expect(authRequest.clientId).toBe(client.id)
    expect(authRequest.scopes).toEqual(['read', 'write'])
    expect(authRequest.state).toBe('abc')
  })

  test('rejects client without authorization_code grant', async () => {
    const { client } = await OAuthClient.create({
      name: 'Machine Only',
      redirectUris: ['https://example.com/callback'],
      grantTypes: ['client_credentials'],
    })
    const user = createMockUser()
    const { ctx } = mockAuthenticatedContext(user, {
      path: '/oauth/authorize',
      query: {
        response_type: 'code',
        client_id: client.id,
        redirect_uri: 'https://example.com/callback',
      },
    })

    const res = await authorizeHandler(ctx)
    expect(res.status).toBe(400)
  })

  // ── PKCE method gate (default: S256-only) ──────────────────────────

  test('defaults code_challenge_method to S256 when only code_challenge is provided', async () => {
    const client = await createTestClient({ firstParty: true })
    const user = createMockUser()
    const { ctx } = mockAuthenticatedContext(user, {
      path: '/oauth/authorize',
      query: {
        response_type: 'code',
        client_id: client.id,
        redirect_uri: 'https://example.com/callback',
        scope: 'read',
        code_challenge: 'abc-challenge',
        // code_challenge_method intentionally omitted
      },
    })

    const res = await authorizeHandler(ctx)
    // First-party clients auto-approve; absence of an error redirect
    // means the request was accepted under the new S256 default.
    expect(res.status).toBe(302)
    const url = new URL(res.headers.get('location')!)
    expect(url.searchParams.get('error')).toBeNull()
    expect(url.searchParams.get('code')).toBeTruthy()
  })

  test('rejects code_challenge_method=plain by default', async () => {
    const client = await createTestClient({ firstParty: true })
    const user = createMockUser()
    const { ctx } = mockAuthenticatedContext(user, {
      path: '/oauth/authorize',
      query: {
        response_type: 'code',
        client_id: client.id,
        redirect_uri: 'https://example.com/callback',
        scope: 'read',
        code_challenge: 'abc',
        code_challenge_method: 'plain',
      },
    })

    const res = await authorizeHandler(ctx)
    expect(res.status).toBe(302)
    const url = new URL(res.headers.get('location')!)
    expect(url.searchParams.get('error')).toBe('invalid_request')
    expect(url.searchParams.get('error_description')).toContain('plain')
    expect(url.searchParams.get('code')).toBeNull()
  })

  test('accepts code_challenge_method=plain when allowPlainPkce is true', async () => {
    bootOAuth2({ scopes: { read: 'Read', write: 'Write' }, allowPlainPkce: true })
    const client = await createTestClient({ firstParty: true })
    const user = createMockUser()
    const { ctx } = mockAuthenticatedContext(user, {
      path: '/oauth/authorize',
      query: {
        response_type: 'code',
        client_id: client.id,
        redirect_uri: 'https://example.com/callback',
        scope: 'read',
        code_challenge: 'abc',
        code_challenge_method: 'plain',
      },
    })

    const res = await authorizeHandler(ctx)
    expect(res.status).toBe(302)
    const url = new URL(res.headers.get('location')!)
    expect(url.searchParams.get('error')).toBeNull()
    expect(url.searchParams.get('code')).toBeTruthy()
  })

  test('rejects unknown code_challenge_method values', async () => {
    const client = await createTestClient({ firstParty: true })
    const user = createMockUser()
    const { ctx } = mockAuthenticatedContext(user, {
      path: '/oauth/authorize',
      query: {
        response_type: 'code',
        client_id: client.id,
        redirect_uri: 'https://example.com/callback',
        scope: 'read',
        code_challenge: 'abc',
        code_challenge_method: 'sha1',
      },
    })

    const res = await authorizeHandler(ctx)
    expect(res.status).toBe(302)
    const url = new URL(res.headers.get('location')!)
    expect(url.searchParams.get('error')).toBe('invalid_request')
  })
})

describe('approveHandler (POST /oauth/authorize)', () => {
  async function setupApproval() {
    const { client } = await OAuthClient.create({
      name: 'Third Party',
      redirectUris: ['https://thirdparty.com/callback'],
      firstParty: false,
    })
    const user = createMockUser()

    const session = new MockSession()
    session.set('_oauth2_auth_request', {
      clientId: client.id,
      redirectUri: 'https://thirdparty.com/callback',
      scopes: ['read'],
      state: 'mystate',
      codeChallenge: null,
      codeChallengeMethod: null,
    })

    return { client, user, session }
  }

  test('issues code on approval', async () => {
    const { user, session } = await setupApproval()
    const ctx = mockContext({
      method: 'POST',
      path: '/oauth/authorize',
      body: { approved: true },
    })
    ctx.set('session', session)
    ctx.set('user', user)

    const res = await approveHandler(ctx)
    expect(res.status).toBe(302)

    const location = res.headers.get('location')!
    const url = new URL(location)
    expect(url.searchParams.get('code')).toBeDefined()
    expect(url.searchParams.get('state')).toBe('mystate')

    // Session auth request should be cleared
    expect(session.has('_oauth2_auth_request')).toBe(false)
  })

  test('redirects with error on denial', async () => {
    const { user, session } = await setupApproval()
    const ctx = mockContext({
      method: 'POST',
      path: '/oauth/authorize',
      body: { approved: false },
    })
    ctx.set('session', session)
    ctx.set('user', user)

    const res = await approveHandler(ctx)
    expect(res.status).toBe(302)

    const location = res.headers.get('location')!
    const url = new URL(location)
    expect(url.searchParams.get('error')).toBe('access_denied')
    expect(url.searchParams.get('state')).toBe('mystate')
  })

  test('rejects when no pending auth request', async () => {
    const user = createMockUser()
    const session = new MockSession()
    const ctx = mockContext({
      method: 'POST',
      path: '/oauth/authorize',
      body: { approved: true },
    })
    ctx.set('session', session)
    ctx.set('user', user)

    const res = await approveHandler(ctx)
    expect(res.status).toBe(400)

    const body = await res.json()
    expect(body.error).toBe('invalid_request')
  })
})
