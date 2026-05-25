import { describe, test, expect, afterEach } from 'bun:test'
import { LineProvider } from '../src/providers/line_provider.ts'
import { mockFetch, lastFetchCall, mockContext } from './helpers.ts'

const originalFetch = globalThis.fetch

const config = {
  clientId: 'line-channel-id',
  clientSecret: 'line-channel-secret',
  redirectUrl: 'http://localhost:3000/auth/line/callback',
}

describe('LineProvider', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('redirect', () => {
    test('builds the authorize URL with the LINE-specific host', () => {
      const provider = new LineProvider(config)
      const ctx = mockContext()

      const response = provider.redirect(ctx)
      const url = new URL(response.headers.get('Location')!)

      expect(url.origin + url.pathname).toBe('https://access.line.me/oauth2/v2.1/authorize')
      expect(url.searchParams.get('client_id')).toBe('line-channel-id')
      expect(url.searchParams.get('redirect_uri')).toBe(
        'http://localhost:3000/auth/line/callback'
      )
      // LINE Login requires `profile` for the basic profile fetch and
      // `openid` to receive an id_token alongside the access token.
      expect(url.searchParams.get('scope')).toBe('profile openid')
      expect(url.searchParams.get('response_type')).toBe('code')
      expect(url.searchParams.get('state')).toBeTruthy()
    })

    test('honours added scopes', () => {
      const provider = new LineProvider(config)
      const ctx = mockContext()
      const response = provider.scopes(['email']).redirect(ctx)
      const url = new URL(response.headers.get('Location')!)
      expect(url.searchParams.get('scope')).toBe('profile openid email')
    })
  })

  describe('user', () => {
    test('exchanges code and maps the profile response', async () => {
      mockFetch([
        // Token exchange response
        {
          body: {
            access_token: 'line-access-token',
            refresh_token: 'line-refresh-token',
            expires_in: 2592000,
            id_token: 'line-id-token',
            scope: 'profile openid',
          },
        },
        // /v2/profile response
        {
          body: {
            userId: 'U1234567890abcdef',
            displayName: 'Somchai',
            pictureUrl: 'https://profile.line.me/p/1.png',
            statusMessage: 'Hello',
          },
        },
      ])

      const provider = new LineProvider(config)
      const state = 'line-state'
      const ctx = mockContext({
        query: { code: 'line-code', state },
        sessionData: { social_state: state },
      })

      const user = await provider.user(ctx)

      expect(user.id).toBe('U1234567890abcdef')
      expect(user.name).toBe('Somchai')
      expect(user.avatar).toBe('https://profile.line.me/p/1.png')
      // No email scope was granted by the mock — should map to null/false.
      expect(user.email).toBeNull()
      expect(user.emailVerified).toBe(false)
      expect(user.token).toBe('line-access-token')
      expect(user.refreshToken).toBe('line-refresh-token')
    })

    test('token endpoint receives client_secret in the body (not Basic auth)', async () => {
      mockFetch([
        { body: { access_token: 't', expires_in: 60 } },
        { body: { userId: 'U1', displayName: 'X' } },
      ])

      const provider = new LineProvider(config)
      const state = 'line-state'
      const ctx = mockContext({
        query: { code: 'line-code', state },
        sessionData: { social_state: state },
      })

      await provider.user(ctx)

      // First call is the token exchange.
      const tokenCall = lastFetchCall(0)
      expect(tokenCall.url).toBe('https://api.line.me/oauth2/v2.1/token')
      const body = (tokenCall.init.body as URLSearchParams).toString()
      expect(body).toContain('client_secret=line-channel-secret')
      // No Authorization header (would be present for HTTP Basic).
      const headers = tokenCall.init.headers as Record<string, string>
      expect(headers.Authorization).toBeUndefined()
    })

    test('maps email + emailVerified=true when LINE returns an email', async () => {
      mockFetch([
        { body: { access_token: 't', expires_in: 60 } },
        {
          body: {
            userId: 'U1',
            displayName: 'X',
            email: 'somchai@example.com',
          },
        },
      ])

      const provider = new LineProvider(config)
      const state = 'line-state'
      const ctx = mockContext({
        query: { code: 'line-code', state },
        sessionData: { social_state: state },
      })

      const user = await provider.user(ctx)
      expect(user.email).toBe('somchai@example.com')
      expect(user.emailVerified).toBe(true)
    })
  })
})
