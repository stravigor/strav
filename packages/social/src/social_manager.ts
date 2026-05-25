import { inject, Configuration, ConfigurationError } from '@strav/kernel'
import { Database, toSnakeCase } from '@strav/database'
import type { AbstractProvider } from './abstract_provider.ts'
import type { ProviderConfig, SocialConfig } from './types.ts'
import { GoogleProvider } from './providers/google_provider.ts'
import { GitHubProvider } from './providers/github_provider.ts'
import { DiscordProvider } from './providers/discord_provider.ts'
import { FacebookProvider } from './providers/facebook_provider.ts'
import { LinkedInProvider } from './providers/linkedin_provider.ts'
import { LineProvider } from './providers/line_provider.ts'

@inject
export default class SocialManager {
  private static _db: Database
  private static _config: SocialConfig
  private static _userFkColumn: string
  private static _extensions = new Map<string, (config: ProviderConfig) => AbstractProvider>()

  constructor(db: Database, config: Configuration) {
    SocialManager._db = db

    const userKey = config.get('social.userKey', 'id') as string
    SocialManager._userFkColumn = `user_${toSnakeCase(userKey)}`

    SocialManager._config = {
      userKey,
      providers: config.get('social.providers', {}) as Record<string, ProviderConfig>,
    }
  }

  static get db(): Database {
    if (!SocialManager._db) {
      throw new ConfigurationError(
        'SocialManager not configured. Resolve it through the container first.'
      )
    }
    return SocialManager._db
  }

  static get config(): SocialConfig {
    if (!SocialManager._config) {
      throw new ConfigurationError(
        'SocialManager not configured. Resolve it through the container first.'
      )
    }
    return SocialManager._config
  }

  /** The FK column name on the social_account table (e.g. `user_id`, `user_uid`). */
  static get userFkColumn(): string {
    return SocialManager._userFkColumn ?? 'user_id'
  }

  /**
   * Get a fresh provider instance by name.
   * Returns a new instance each call because fluent methods mutate state.
   */
  static driver(name: string): AbstractProvider {
    const providerConfig = SocialManager._config?.providers[name]
    if (!providerConfig) {
      throw new ConfigurationError(`Social provider "${name}" is not configured.`)
    }

    const driverName = providerConfig.driver ?? name

    const extension = SocialManager._extensions.get(driverName)
    if (extension) return extension(providerConfig)

    switch (driverName) {
      case 'google':
        return new GoogleProvider(providerConfig)
      case 'github':
        return new GitHubProvider(providerConfig)
      case 'discord':
        return new DiscordProvider(providerConfig)
      case 'facebook':
        return new FacebookProvider(providerConfig)
      case 'linkedin':
        return new LinkedInProvider(providerConfig)
      case 'line':
        return new LineProvider(providerConfig)
      default:
        throw new ConfigurationError(
          `Unknown social driver "${driverName}". Register it with SocialManager.extend().`
        )
    }
  }

  /** Register a custom provider factory. */
  static extend(name: string, factory: (config: ProviderConfig) => AbstractProvider): void {
    SocialManager._extensions.set(name, factory)
  }

  /** Clear all custom extensions (useful for testing). */
  static reset(): void {
    SocialManager._extensions.clear()
  }
}
