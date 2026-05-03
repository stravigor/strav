import { describe, test, expect, afterEach } from 'bun:test'
import { LinkedInProvider } from '../src/providers/linkedin_provider.ts'
import { mockFetch, lastFetchCall, mockContext } from './helpers.ts'

const originalFetch = globalThis.fetch

const config = {
  clientId: 'li-client-id',
  clientSecret: 'li-client-secret',
  redirectUrl: 'http://localhost:3000/auth/linkedin/callback',
}

describe('LinkedInProvider', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // ---------------------------------------------------------------------------
  // Auth URL
  // ---------------------------------------------------------------------------

  describe('redirect', () => {
    test('builds correct authorization URL', () => {
      const provider = new LinkedInProvider(config)
      const ctx = mockContext()

      const response = provider.redirect(ctx)
      const url = new URL(response.headers.get('Location')!)

      expect(url.origin + url.pathname).toBe('https://www.linkedin.com/oauth/v2/authorization')
      expect(url.searchParams.get('client_id')).toBe('li-client-id')
      expect(url.searchParams.get('redirect_uri')).toBe(
        'http://localhost:3000/auth/linkedin/callback'
      )
      expect(url.searchParams.get('scope')).toBe('openid profile email')
    })

    test('adds extra scopes', () => {
      const provider = new LinkedInProvider(config)
      const ctx = mockContext()

      const response = provider.scopes(['w_member_social']).redirect(ctx)
      const url = new URL(response.headers.get('Location')!)

      expect(url.searchParams.get('scope')).toBe('openid profile email w_member_social')
    })
  })

  // ---------------------------------------------------------------------------
  // User retrieval
  // ---------------------------------------------------------------------------

  describe('user', () => {
    test('exchanges code and fetches user profile', async () => {
      mockFetch([
        // Token exchange
        { body: { access_token: 'li-token', expires_in: 5184000 } },
        // User profile (OIDC userinfo)
        {
          body: {
            sub: 'abc123xyz',
            name: 'John Doe',
            email: 'john@linkedin.com',
            picture: 'https://media.licdn.com/photo.jpg',
          },
        },
      ])

      const provider = new LinkedInProvider(config)
      const state = 'li-state'
      const ctx = mockContext({
        query: { code: 'li-code', state },
        sessionData: { social_state: state },
      })

      const user = await provider.user(ctx)

      expect(user.id).toBe('abc123xyz')
      expect(user.name).toBe('John Doe')
      expect(user.email).toBe('john@linkedin.com')
      expect(user.avatar).toBe('https://media.licdn.com/photo.jpg')
      expect(user.nickname).toBeNull()
      expect(user.token).toBe('li-token')
    })

    test('maps email_verified=true to emailVerified=true', async () => {
      mockFetch([
        { body: { access_token: 'tok' } },
        { body: { sub: '1', email: 'a@b.com', email_verified: true } },
      ])
      const provider = new LinkedInProvider(config)
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
        { body: { access_token: 'tok' } },
        { body: { sub: '1', email: 'a@b.com' } },
      ])
      const provider = new LinkedInProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })
      const user = await provider.user(ctx)
      expect(user.emailVerified).toBe(false)
    })

    test('sends token exchange to correct URL', async () => {
      mockFetch([{ body: { access_token: 'tok' } }, { body: { sub: '1', name: 'X' } }])

      const provider = new LinkedInProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })

      await provider.user(ctx)

      expect(lastFetchCall(0).url).toBe('https://www.linkedin.com/oauth/v2/accessToken')
    })

    test('fetches from OIDC userinfo endpoint', async () => {
      mockFetch([{ body: { access_token: 'tok' } }, { body: { sub: '1', name: 'X' } }])

      const provider = new LinkedInProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })

      await provider.user(ctx)

      expect(lastFetchCall(1).url).toBe('https://api.linkedin.com/v2/userinfo')
      expect(lastFetchCall(1).init.headers.Authorization).toBe('Bearer tok')
    })

    test('handles null fields', async () => {
      mockFetch([{ body: { access_token: 'tok' } }, { body: { sub: '999' } }])

      const provider = new LinkedInProvider(config)
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
            sub: '777',
            name: 'Jane Pro',
            email: 'jane@linkedin.com',
            picture: 'https://example.com/photo.jpg',
          },
        },
      ])

      const provider = new LinkedInProvider(config)
      const user = await provider.userFromToken('existing-token')

      expect(user.id).toBe('777')
      expect(user.name).toBe('Jane Pro')
      expect(user.token).toBe('existing-token')
      expect(user.refreshToken).toBeNull()
    })
  })
})
