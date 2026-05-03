import { describe, test, expect, afterEach } from 'bun:test'
import { DiscordProvider } from '../src/providers/discord_provider.ts'
import { mockFetch, lastFetchCall, mockContext } from './helpers.ts'

const originalFetch = globalThis.fetch

const config = {
  clientId: 'discord-client-id',
  clientSecret: 'discord-client-secret',
  redirectUrl: 'http://localhost:3000/auth/discord/callback',
}

describe('DiscordProvider', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // ---------------------------------------------------------------------------
  // Auth URL
  // ---------------------------------------------------------------------------

  describe('redirect', () => {
    test('builds correct authorization URL', () => {
      const provider = new DiscordProvider(config)
      const ctx = mockContext()

      const response = provider.redirect(ctx)
      const url = new URL(response.headers.get('Location')!)

      expect(url.origin + url.pathname).toBe('https://discord.com/api/oauth2/authorize')
      expect(url.searchParams.get('client_id')).toBe('discord-client-id')
      expect(url.searchParams.get('scope')).toBe('identify email')
    })

    test('adds guilds scope', () => {
      const provider = new DiscordProvider(config)
      const ctx = mockContext()

      const response = provider.scopes(['guilds']).redirect(ctx)
      const url = new URL(response.headers.get('Location')!)

      expect(url.searchParams.get('scope')).toBe('identify email guilds')
    })
  })

  // ---------------------------------------------------------------------------
  // User retrieval
  // ---------------------------------------------------------------------------

  describe('user', () => {
    test('exchanges code and fetches user profile', async () => {
      mockFetch([
        // Token exchange
        { body: { access_token: 'discord-tok', expires_in: 604800, scope: 'identify email' } },
        // User profile
        {
          body: {
            id: '123456789012345678',
            username: 'johndoe',
            global_name: 'John Doe',
            email: 'john@example.com',
            avatar: 'abc123',
          },
        },
      ])

      const provider = new DiscordProvider(config)
      const state = 'discord-state'
      const ctx = mockContext({
        query: { code: 'discord-code', state },
        sessionData: { social_state: state },
      })

      const user = await provider.user(ctx)

      expect(user.id).toBe('123456789012345678')
      expect(user.nickname).toBe('johndoe')
      expect(user.name).toBe('John Doe')
      expect(user.email).toBe('john@example.com')
      expect(user.avatar).toBe('https://cdn.discordapp.com/avatars/123456789012345678/abc123.png')
      expect(user.token).toBe('discord-tok')
      expect(user.expiresIn).toBe(604800)
    })

    test('maps verified=true to emailVerified=true', async () => {
      mockFetch([
        { body: { access_token: 'tok' } },
        { body: { id: '1', username: 'x', email: 'a@b.com', verified: true } },
      ])
      const provider = new DiscordProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })
      const user = await provider.user(ctx)
      expect(user.emailVerified).toBe(true)
    })

    test('maps verified=false to emailVerified=false', async () => {
      mockFetch([
        { body: { access_token: 'tok' } },
        { body: { id: '1', username: 'x', email: 'a@b.com', verified: false } },
      ])
      const provider = new DiscordProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })
      const user = await provider.user(ctx)
      expect(user.emailVerified).toBe(false)
    })

    test('uses default avatar when no custom avatar', async () => {
      mockFetch([
        { body: { access_token: 'tok' } },
        {
          body: {
            id: '123456789012345678',
            username: 'noavatar',
            global_name: null,
            email: null,
            avatar: null,
          },
        },
      ])

      const provider = new DiscordProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })

      const user = await provider.user(ctx)

      // Default avatar index = (id >> 22) % 6
      expect(user.avatar).toMatch(/^https:\/\/cdn\.discordapp\.com\/embed\/avatars\/\d\.png$/)
    })

    test('sends token exchange to correct URL', async () => {
      mockFetch([{ body: { access_token: 'tok' } }, { body: { id: '1', username: 'x' } }])

      const provider = new DiscordProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })

      await provider.user(ctx)

      expect(lastFetchCall(0).url).toBe('https://discord.com/api/oauth2/token')
    })

    test('fetches from v10 users endpoint', async () => {
      mockFetch([{ body: { access_token: 'tok' } }, { body: { id: '1', username: 'x' } }])

      const provider = new DiscordProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })

      await provider.user(ctx)

      expect(lastFetchCall(1).url).toBe('https://discord.com/api/v10/users/@me')
    })

    test('handles null fields', async () => {
      mockFetch([
        { body: { access_token: 'tok' } },
        { body: { id: '1', username: 'x', global_name: null, email: null, avatar: null } },
      ])

      const provider = new DiscordProvider(config)
      const state = 's'
      const ctx = mockContext({
        query: { code: 'c', state },
        sessionData: { social_state: state },
      })

      const user = await provider.user(ctx)
      expect(user.name).toBeNull()
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
            id: '999',
            username: 'bot',
            global_name: 'Bot User',
            email: 'bot@discord.com',
            avatar: 'def456',
          },
        },
      ])

      const provider = new DiscordProvider(config)
      const user = await provider.userFromToken('existing-tok')

      expect(user.id).toBe('999')
      expect(user.token).toBe('existing-tok')
      expect(user.refreshToken).toBeNull()
    })
  })
})
