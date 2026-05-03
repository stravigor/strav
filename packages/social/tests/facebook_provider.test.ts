import { describe, test, expect, afterEach } from 'bun:test'
import { FacebookProvider } from '../src/providers/facebook_provider.ts'
import { mockFetch, lastFetchCall, mockContext } from './helpers.ts'

const originalFetch = globalThis.fetch

const config = {
  clientId: 'fb-client-id',
  clientSecret: 'fb-client-secret',
  redirectUrl: 'http://localhost:3000/auth/facebook/callback',
}

describe('FacebookProvider', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // ---------------------------------------------------------------------------
  // Auth URL
  // ---------------------------------------------------------------------------

  describe('redirect', () => {
    test('builds correct authorization URL', () => {
      const provider = new FacebookProvider(config)
      const ctx = mockContext()

      const response = provider.redirect(ctx)
      const url = new URL(response.headers.get('Location')!)

      expect(url.origin + url.pathname).toBe('https://www.facebook.com/v21.0/dialog/oauth')
      expect(url.searchParams.get('client_id')).toBe('fb-client-id')
      expect(url.searchParams.get('redirect_uri')).toBe(
        'http://localhost:3000/auth/facebook/callback'
      )
      expect(url.searchParams.get('scope')).toBe('email public_profile')
    })

    test('adds extra scopes', () => {
      const provider = new FacebookProvider(config)
      const ctx = mockContext()

      const response = provider.scopes(['user_birthday']).redirect(ctx)
      const url = new URL(response.headers.get('Location')!)

      expect(url.searchParams.get('scope')).toBe('email public_profile user_birthday')
    })
  })

  // ---------------------------------------------------------------------------
  // User retrieval
  // ---------------------------------------------------------------------------

  describe('user', () => {
    test('exchanges code and fetches user profile', async () => {
      mockFetch([
        // Token exchange
        { body: { access_token: 'fb-token', expires_in: 5184000 } },
        // User profile
        {
          body: {
            id: '10229876543210',
            name: 'John Doe',
            email: 'john@example.com',
            picture: { data: { url: 'https://graph.facebook.com/photo.jpg' } },
          },
        },
      ])

      const provider = new FacebookProvider(config)
      const state = 'fb-state'
      const ctx = mockContext({
        query: { code: 'fb-code', state },
        sessionData: { social_state: state },
      })

      const user = await provider.user(ctx)

      expect(user.id).toBe('10229876543210')
      expect(user.name).toBe('John Doe')
      expect(user.email).toBe('john@example.com')
      expect(user.avatar).toBe('https://graph.facebook.com/photo.jpg')
      expect(user.nickname).toBeNull()
      expect(user.token).toBe('fb-token')
      expect(user.expiresIn).toBe(5184000)
      expect(user.emailVerified).toBe(true)
    })

    test('maps null email to emailVerified=false', async () => {
      mockFetch([
        { body: { access_token: 'tok' } },
        { body: { id: '1', name: 'X', email: null } },
      ])
      const provider = new FacebookProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })
      const user = await provider.user(ctx)
      expect(user.emailVerified).toBe(false)
    })

    test('sends token exchange to correct URL', async () => {
      mockFetch([{ body: { access_token: 'tok' } }, { body: { id: '1', name: 'X' } }])

      const provider = new FacebookProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })

      await provider.user(ctx)

      expect(lastFetchCall(0).url).toBe('https://graph.facebook.com/v21.0/oauth/access_token')
    })

    test('fetches user with fields parameter', async () => {
      mockFetch([{ body: { access_token: 'tok' } }, { body: { id: '1', name: 'X' } }])

      const provider = new FacebookProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })

      await provider.user(ctx)

      const userCall = lastFetchCall(1).url
      expect(userCall).toContain('graph.facebook.com/v21.0/me')
      expect(userCall).toContain('fields=id,name,email,picture.type(large)')
    })

    test('handles missing picture data', async () => {
      mockFetch([
        { body: { access_token: 'tok' } },
        { body: { id: '1', name: 'No Pic', email: null } },
      ])

      const provider = new FacebookProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })

      const user = await provider.user(ctx)
      expect(user.avatar).toBeNull()
      expect(user.email).toBeNull()
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
            id: '42',
            name: 'Jane',
            email: 'jane@fb.com',
            picture: { data: { url: 'https://example.com/avatar.jpg' } },
          },
        },
      ])

      const provider = new FacebookProvider(config)
      const user = await provider.userFromToken('my-token')

      expect(user.id).toBe('42')
      expect(user.name).toBe('Jane')
      expect(user.token).toBe('my-token')
      expect(user.refreshToken).toBeNull()

      expect(lastFetchCall(0).url).toContain('access_token=my-token')
    })
  })
})
