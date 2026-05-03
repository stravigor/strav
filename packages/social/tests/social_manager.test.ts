import { describe, test, expect, beforeEach } from 'bun:test'
import SocialManager from '../src/social_manager.ts'
import { GoogleProvider } from '../src/providers/google_provider.ts'
import { GitHubProvider } from '../src/providers/github_provider.ts'
import { DiscordProvider } from '../src/providers/discord_provider.ts'
import { FacebookProvider } from '../src/providers/facebook_provider.ts'
import { LinkedInProvider } from '../src/providers/linkedin_provider.ts'
import { AbstractProvider } from '../src/abstract_provider.ts'
import type { ProviderConfig, SocialUser } from '../src/types.ts'

function mockDb() {
  return {
    sql: Object.assign(() => Promise.resolve([]), { unsafe: () => Promise.resolve([]) }),
  } as any
}

// Minimal mock of Configuration with dot-notation get()
function mockConfig(data: Record<string, unknown>) {
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
  } as any
}

const providers = {
  google: {
    clientId: 'g-id',
    clientSecret: 'g-secret',
    redirectUrl: 'http://localhost/auth/google/callback',
  },
  github: {
    clientId: 'gh-id',
    clientSecret: 'gh-secret',
    redirectUrl: 'http://localhost/auth/github/callback',
  },
  discord: {
    clientId: 'd-id',
    clientSecret: 'd-secret',
    redirectUrl: 'http://localhost/auth/discord/callback',
  },
  facebook: {
    clientId: 'fb-id',
    clientSecret: 'fb-secret',
    redirectUrl: 'http://localhost/auth/facebook/callback',
  },
  linkedin: {
    clientId: 'li-id',
    clientSecret: 'li-secret',
    redirectUrl: 'http://localhost/auth/linkedin/callback',
  },
}

describe('SocialManager', () => {
  beforeEach(() => {
    new SocialManager(mockDb(), mockConfig({ social: { providers } }))
    SocialManager.reset()
  })

  test('resolves Google provider', () => {
    const driver = SocialManager.driver('google')
    expect(driver).toBeInstanceOf(GoogleProvider)
  })

  test('resolves GitHub provider', () => {
    const driver = SocialManager.driver('github')
    expect(driver).toBeInstanceOf(GitHubProvider)
  })

  test('resolves Discord provider', () => {
    const driver = SocialManager.driver('discord')
    expect(driver).toBeInstanceOf(DiscordProvider)
  })

  test('resolves Facebook provider', () => {
    const driver = SocialManager.driver('facebook')
    expect(driver).toBeInstanceOf(FacebookProvider)
  })

  test('resolves LinkedIn provider', () => {
    const driver = SocialManager.driver('linkedin')
    expect(driver).toBeInstanceOf(LinkedInProvider)
  })

  test('throws on unknown provider', () => {
    expect(() => SocialManager.driver('unknown')).toThrow(
      'Social provider "unknown" is not configured.'
    )
  })

  test('throws on unknown driver name', () => {
    new SocialManager(
      mockDb(),
      mockConfig({
        social: {
          providers: {
            custom: { driver: 'nonexistent', clientId: 'x', clientSecret: 'x', redirectUrl: 'x' },
          },
        },
      })
    )

    expect(() => SocialManager.driver('custom')).toThrow(
      'Unknown social driver "nonexistent"'
    )
  })

  test('returns fresh instances each call', () => {
    const a = SocialManager.driver('google')
    const b = SocialManager.driver('google')
    expect(a).not.toBe(b)
  })

  test('extend() registers custom provider factory', () => {
    class CustomProvider extends AbstractProvider {
      readonly name = 'Custom'
      protected getDefaultScopes() {
        return ['custom']
      }
      protected getAuthUrl() {
        return 'https://custom.com/auth'
      }
      protected getTokenUrl() {
        return 'https://custom.com/token'
      }
      protected async getUserByToken() {
        return {}
      }
      protected mapUserToObject(): SocialUser {
        return {
          id: '1',
          name: null,
          email: null,
          emailVerified: false,
          avatar: null,
          nickname: null,
          token: '',
          refreshToken: null,
          expiresIn: null,
          approvedScopes: [],
          raw: {},
        }
      }
    }

    // Register under the driver name 'custom-driver'
    new SocialManager(
      mockDb(),
      mockConfig({
        social: {
          providers: {
            myapp: {
              driver: 'custom-driver',
              clientId: 'x',
              clientSecret: 'x',
              redirectUrl: 'x',
            },
          },
        },
      })
    )

    SocialManager.extend('custom-driver', (config: ProviderConfig) => new CustomProvider(config))

    const driver = SocialManager.driver('myapp')
    expect(driver).toBeInstanceOf(CustomProvider)
  })

  test('extend() with driver alias works', () => {
    // Use driver field to alias a built-in
    new SocialManager(
      mockDb(),
      mockConfig({
        social: {
          providers: {
            company: { driver: 'google', clientId: 'c', clientSecret: 's', redirectUrl: 'r' },
          },
        },
      })
    )

    const driver = SocialManager.driver('company')
    expect(driver).toBeInstanceOf(GoogleProvider)
  })

  test('reset() clears extensions', () => {
    SocialManager.extend('test', () => new GoogleProvider(providers.google))

    SocialManager.reset()

    // Extension is gone, so 'test' driver should fail (it's not a built-in)
    new SocialManager(
      mockDb(),
      mockConfig({
        social: {
          providers: {
            testprov: { driver: 'test', clientId: 'x', clientSecret: 'x', redirectUrl: 'x' },
          },
        },
      })
    )

    expect(() => SocialManager.driver('testprov')).toThrow('Unknown social driver "test"')
  })
})
