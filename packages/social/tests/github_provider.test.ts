import { describe, test, expect, afterEach } from 'bun:test'
import { GitHubProvider } from '../src/providers/github_provider.ts'
import { mockFetch, lastFetchCall, mockContext } from './helpers.ts'

const originalFetch = globalThis.fetch

const config = {
  clientId: 'gh-client-id',
  clientSecret: 'gh-client-secret',
  redirectUrl: 'http://localhost:3000/auth/github/callback',
}

describe('GitHubProvider', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // ---------------------------------------------------------------------------
  // Auth URL
  // ---------------------------------------------------------------------------

  describe('redirect', () => {
    test('builds correct authorization URL', () => {
      const provider = new GitHubProvider(config)
      const ctx = mockContext()

      const response = provider.redirect(ctx)
      const url = new URL(response.headers.get('Location')!)

      expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize')
      expect(url.searchParams.get('client_id')).toBe('gh-client-id')
      expect(url.searchParams.get('scope')).toBe('read:user user:email')
    })

    test('adds extra scopes', () => {
      const provider = new GitHubProvider(config)
      const ctx = mockContext()

      const response = provider.scopes(['repo']).redirect(ctx)
      const url = new URL(response.headers.get('Location')!)

      expect(url.searchParams.get('scope')).toBe('read:user user:email repo')
    })
  })

  // ---------------------------------------------------------------------------
  // User retrieval
  // ---------------------------------------------------------------------------

  describe('user', () => {
    test('exchanges code and fetches user profile + emails', async () => {
      mockFetch([
        // Token exchange
        { body: { access_token: 'gh-token', scope: 'read:user,user:email' } },
        // User profile
        {
          body: {
            id: 12345,
            login: 'johndoe',
            name: 'John Doe',
            email: 'john@example.com',
            avatar_url: 'https://avatars.githubusercontent.com/u/12345',
          },
        },
        // User emails
        {
          body: [
            { email: 'john@example.com', primary: true, verified: true },
            { email: 'john@work.com', primary: false, verified: true },
          ],
        },
      ])

      const provider = new GitHubProvider(config)
      const state = 'gh-state'
      const ctx = mockContext({
        query: { code: 'gh-code', state },
        sessionData: { social_state: state },
      })

      const user = await provider.user(ctx)

      expect(user.id).toBe('12345')
      expect(user.nickname).toBe('johndoe')
      expect(user.name).toBe('John Doe')
      expect(user.email).toBe('john@example.com')
      expect(user.avatar).toBe('https://avatars.githubusercontent.com/u/12345')
      expect(user.token).toBe('gh-token')
      expect(user.emailVerified).toBe(true)
    })

    test('maps null email to emailVerified=false', async () => {
      mockFetch([
        { body: { access_token: 'tok' } },
        { body: { id: 1, login: 'x', name: null, email: null, avatar_url: null } },
        { body: [] },
      ])
      const provider = new GitHubProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })
      const user = await provider.user(ctx)
      expect(user.email).toBeNull()
      expect(user.emailVerified).toBe(false)
    })

    test('falls back to primary email when profile email is null', async () => {
      mockFetch([
        { body: { access_token: 'gh-token' } },
        // User with no email
        { body: { id: 99, login: 'hidden', name: 'Hidden', email: null, avatar_url: null } },
        // Emails endpoint
        {
          body: [
            { email: 'hidden@private.com', primary: true, verified: true },
            { email: 'other@example.com', primary: false, verified: true },
          ],
        },
      ])

      const provider = new GitHubProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })

      const user = await provider.user(ctx)
      expect(user.email).toBe('hidden@private.com')
    })

    test('sends User-Agent header on GitHub API calls', async () => {
      mockFetch([{ body: { access_token: 'tok' } }, { body: { id: 1, login: 'x' } }, { body: [] }])

      const provider = new GitHubProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })

      await provider.user(ctx)

      // User profile call (index 1) and emails call (index 2) should have User-Agent
      expect(lastFetchCall(1).init.headers['User-Agent']).toBe('Strav-Social')
      expect(lastFetchCall(2).init.headers['User-Agent']).toBe('Strav-Social')
    })

    test('converts numeric id to string', async () => {
      mockFetch([
        { body: { access_token: 'tok' } },
        { body: { id: 42, login: 'test' } },
        { body: [] },
      ])

      const provider = new GitHubProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })

      const user = await provider.user(ctx)
      expect(user.id).toBe('42')
      expect(typeof user.id).toBe('string')
    })

    test('handles no verified primary email', async () => {
      mockFetch([
        { body: { access_token: 'tok' } },
        { body: { id: 1, login: 'x', email: null } },
        { body: [{ email: 'unverified@x.com', primary: true, verified: false }] },
      ])

      const provider = new GitHubProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })

      const user = await provider.user(ctx)
      expect(user.email).toBeNull()
    })
  })

  // ---------------------------------------------------------------------------
  // userFromToken
  // ---------------------------------------------------------------------------

  describe('userFromToken', () => {
    test('fetches user with existing token', async () => {
      mockFetch([
        { body: { id: 77, login: 'bot', name: 'Bot', avatar_url: 'https://example.com/a.png' } },
        { body: [{ email: 'bot@gh.com', primary: true, verified: true }] },
      ])

      const provider = new GitHubProvider(config)
      const user = await provider.userFromToken('my-token')

      expect(user.id).toBe('77')
      expect(user.nickname).toBe('bot')
      expect(user.token).toBe('my-token')
    })
  })
})
