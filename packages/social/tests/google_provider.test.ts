import { describe, test, expect, afterEach } from 'bun:test'
import { GoogleProvider } from '../src/providers/google_provider.ts'
import { mockFetch, lastFetchCall, mockContext } from './helpers.ts'

const originalFetch = globalThis.fetch

const config = {
  clientId: 'google-client-id',
  clientSecret: 'google-client-secret',
  redirectUrl: 'http://localhost:3000/auth/google/callback',
}

describe('GoogleProvider', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // ---------------------------------------------------------------------------
  // Auth URL
  // ---------------------------------------------------------------------------

  describe('redirect', () => {
    test('builds correct authorization URL', () => {
      const provider = new GoogleProvider(config)
      const ctx = mockContext()

      const response = provider.redirect(ctx)
      const location = response.headers.get('Location')!
      const url = new URL(location)

      expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
      expect(url.searchParams.get('client_id')).toBe('google-client-id')
      expect(url.searchParams.get('redirect_uri')).toBe(
        'http://localhost:3000/auth/google/callback'
      )
      expect(url.searchParams.get('response_type')).toBe('code')
      expect(url.searchParams.get('scope')).toBe('openid email profile')
    })

    test('includes state parameter and stores in session', () => {
      const provider = new GoogleProvider(config)
      const ctx = mockContext()

      const response = provider.redirect(ctx)
      const location = response.headers.get('Location')!
      const url = new URL(location)

      const state = url.searchParams.get('state')
      expect(state).toBeTruthy()
      expect(state!.length).toBe(64)
      expect(ctx.session.get('social_state')).toBe(state)
    })

    test('adds extra scopes', () => {
      const provider = new GoogleProvider(config)
      const ctx = mockContext()

      const response = provider.scopes(['calendar.readonly']).redirect(ctx)
      const location = response.headers.get('Location')!
      const url = new URL(location)

      expect(url.searchParams.get('scope')).toBe('openid email profile calendar.readonly')
    })

    test('adds custom parameters', () => {
      const provider = new GoogleProvider(config)
      const ctx = mockContext()

      const response = provider.with({ hd: 'example.com', prompt: 'consent' }).redirect(ctx)
      const location = response.headers.get('Location')!
      const url = new URL(location)

      expect(url.searchParams.get('hd')).toBe('example.com')
      expect(url.searchParams.get('prompt')).toBe('consent')
    })

    test('overrides all scopes with setScopes', () => {
      const provider = new GoogleProvider(config)
      const ctx = mockContext()

      const response = provider.setScopes(['openid']).redirect(ctx)
      const location = response.headers.get('Location')!
      const url = new URL(location)

      expect(url.searchParams.get('scope')).toBe('openid')
    })
  })

  // ---------------------------------------------------------------------------
  // User retrieval
  // ---------------------------------------------------------------------------

  describe('user', () => {
    test('exchanges code for token and fetches user', async () => {
      mockFetch([
        // Token exchange
        {
          body: {
            access_token: 'google-token-123',
            refresh_token: 'google-refresh',
            expires_in: 3600,
            scope: 'openid email profile',
          },
        },
        // User info
        {
          body: {
            sub: '123456789',
            name: 'John Doe',
            email: 'john@gmail.com',
            picture: 'https://lh3.googleusercontent.com/photo.jpg',
          },
        },
      ])

      const provider = new GoogleProvider(config)
      const state = 'valid-state'
      const ctx = mockContext({
        query: { code: 'auth-code', state },
        sessionData: { social_state: state },
      })

      const user = await provider.user(ctx)

      expect(user.id).toBe('123456789')
      expect(user.name).toBe('John Doe')
      expect(user.email).toBe('john@gmail.com')
      expect(user.avatar).toBe('https://lh3.googleusercontent.com/photo.jpg')
      expect(user.nickname).toBeNull()
      expect(user.token).toBe('google-token-123')
      expect(user.refreshToken).toBe('google-refresh')
      expect(user.expiresIn).toBe(3600)
    })

    test('maps email_verified=true to emailVerified=true', async () => {
      mockFetch([
        { body: { access_token: 'tok', expires_in: 3600 } },
        { body: { sub: '1', email: 'x@y.com', email_verified: true } },
      ])
      const provider = new GoogleProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })
      const user = await provider.user(ctx)
      expect(user.emailVerified).toBe(true)
    })

    test('maps missing email_verified to emailVerified=false', async () => {
      mockFetch([
        { body: { access_token: 'tok', expires_in: 3600 } },
        { body: { sub: '1', email: 'x@y.com' } },
      ])
      const provider = new GoogleProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })
      const user = await provider.user(ctx)
      expect(user.emailVerified).toBe(false)
    })

    test('sends correct token exchange request', async () => {
      mockFetch([
        { body: { access_token: 'tok', expires_in: 3600 } },
        { body: { sub: '1', name: 'X', email: 'x@y.com' } },
      ])

      const provider = new GoogleProvider(config)
      const state = 'test-state'
      const ctx = mockContext({
        query: { code: 'the-code', state },
        sessionData: { social_state: state },
      })

      await provider.user(ctx)

      const tokenCall = lastFetchCall(0)
      expect(tokenCall.url).toBe('https://oauth2.googleapis.com/token')
      expect(tokenCall.init.method).toBe('POST')

      // Default token-endpoint auth is HTTP Basic (RFC 6749 §2.3.1) —
      // client_secret lives in the Authorization header, NOT the body.
      const expectedAuth =
        'Basic ' + Buffer.from('google-client-id:google-client-secret', 'utf8').toString('base64')
      expect(tokenCall.init.headers.Authorization).toBe(expectedAuth)

      const body = new URLSearchParams(tokenCall.init.body)
      expect(body.get('grant_type')).toBe('authorization_code')
      expect(body.get('client_id')).toBe('google-client-id')
      expect(body.get('client_secret')).toBeNull() // not in body when Basic
      expect(body.get('code')).toBe('the-code')
      expect(body.get('redirect_uri')).toBe('http://localhost:3000/auth/google/callback')
    })

    test('respects tokenEndpointAuthMethod=post (puts client_secret in body)', async () => {
      mockFetch([
        { body: { access_token: 'tok', expires_in: 3600 } },
        { body: { sub: '1' } },
      ])

      const provider = new GoogleProvider({ ...config, tokenEndpointAuthMethod: 'post' })
      const state = 'test-state'
      const ctx = mockContext({
        query: { code: 'the-code', state },
        sessionData: { social_state: state },
      })

      await provider.user(ctx)

      const tokenCall = lastFetchCall(0)
      expect(tokenCall.init.headers.Authorization).toBeUndefined()

      const body = new URLSearchParams(tokenCall.init.body)
      expect(body.get('client_secret')).toBe('google-client-secret')
    })

    test('verifies state parameter', async () => {
      const provider = new GoogleProvider(config)
      const ctx = mockContext({
        query: { code: 'auth-code', state: 'wrong-state' },
        sessionData: { social_state: 'expected-state' },
      })

      await expect(provider.user(ctx)).rejects.toThrow('Invalid state parameter')
    })

    test('throws on missing authorization code', async () => {
      const provider = new GoogleProvider(config)
      const ctx = mockContext({
        query: { state: 'valid' },
        sessionData: { social_state: 'valid' },
      })

      await expect(provider.user(ctx)).rejects.toThrow('Missing authorization code')
    })

    test('throws on OAuth error response', async () => {
      const provider = new GoogleProvider(config)
      const ctx = mockContext({
        query: { error: 'access_denied', state: 'valid' },
        sessionData: { social_state: 'valid' },
      })

      await expect(provider.user(ctx)).rejects.toThrow('OAuth error: access_denied')
    })

    test('clears state from session after successful verification', async () => {
      mockFetch([
        { body: { access_token: 'tok', expires_in: 3600 } },
        { body: { sub: '1', name: 'X', email: 'x@y.com' } },
      ])

      const provider = new GoogleProvider(config)
      const state = 'test-state'
      const ctx = mockContext({
        query: { code: 'auth-code', state },
        sessionData: { social_state: state },
      })

      await provider.user(ctx)
      expect(ctx.session.get('social_state')).toBeUndefined()
    })

    test('handles null fields gracefully', async () => {
      mockFetch([{ body: { access_token: 'tok', expires_in: 3600 } }, { body: { sub: '999' } }])

      const provider = new GoogleProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })

      const user = await provider.user(ctx)
      expect(user.id).toBe('999')
      expect(user.name).toBeNull()
      expect(user.email).toBeNull()
      expect(user.avatar).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // userFromToken
  // ---------------------------------------------------------------------------

  describe('userFromToken', () => {
    test('fetches user with existing token', async () => {
      mockFetch([
        {
          body: {
            sub: '42',
            name: 'Jane',
            email: 'jane@gmail.com',
            picture: 'https://example.com/avatar.png',
          },
        },
      ])

      const provider = new GoogleProvider(config)
      const user = await provider.userFromToken('existing-token')

      expect(user.id).toBe('42')
      expect(user.name).toBe('Jane')
      expect(user.token).toBe('existing-token')
      expect(user.refreshToken).toBeNull()
      expect(user.expiresIn).toBeNull()

      const call = lastFetchCall(0)
      expect(call.init.headers.Authorization).toBe('Bearer existing-token')
    })
  })
})
