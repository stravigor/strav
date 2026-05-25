import { inject, Configuration, ConfigurationError } from '@strav/kernel'
import { Database, toSnakeCase } from '@strav/database'
import PublisherCredentials from './credentials/credentials.ts'
import {
  CredentialsNotFoundError,
  CredentialsRefreshError,
  PublisherNotRegisteredError,
} from './errors.ts'
import type { Publisher } from './publisher.ts'
import type { PublishContent, PublishResult } from './types.ts'

interface PublishDispatchOptions {
  tenantId: string | number
  platform: string
  /**
   * Pick a specific account when the tenant has multiple credentials for
   * the same platform (multiple Facebook Pages, multiple GBP locations).
   * If omitted, the first credential found for (tenant, platform) is used.
   */
  accountId?: string
  content: PublishContent
}

/**
 * Central registry + dispatcher for publishers.
 *
 * Holds the Database handle, the tenant FK column name (so credential
 * reads are consistent with the app's tenant registry choice), and a map
 * of registered Publisher instances.
 *
 * Typical wiring:
 *
 *   app.singleton(PublisherManager)
 *   app.resolve(PublisherManager)
 *
 *   PublisherManager.register(new WordPressPublisher())
 *   PublisherManager.register(new MetaPublisher())
 *   PublisherManager.register(new GoogleBusinessProfilePublisher())
 *   PublisherManager.register(new LineBroadcastPublisher())
 *
 *   const result = await PublisherManager.publish({
 *     tenantId: 'acme',
 *     platform: 'google_business',
 *     content: { language: 'en', body: 'New croissant...', media: [...] },
 *   })
 *
 * The manager handles auto-refresh: if the credential's `expiresAt` is
 * past (within a 60s skew window) and the registered publisher implements
 * `refresh()`, it mints new tokens, persists them, then dispatches the
 * publish call.
 */
@inject
export default class PublisherManager {
  private static _db: Database
  private static _tenantFk: string
  private static _publishers = new Map<string, Publisher>()
  private static _refreshSkewSeconds = 60

  constructor(db: Database, config: Configuration) {
    PublisherManager._db = db
    const tenantKey = config.get('publish.tenantKey', 'id') as string
    const tenantTable = config.get('database.tenant.table', 'tenant') as string
    PublisherManager._tenantFk = `${toSnakeCase(tenantTable)}_${toSnakeCase(tenantKey)}`

    const skew = config.get('publish.refreshSkewSeconds')
    if (typeof skew === 'number' && skew > 0) {
      PublisherManager._refreshSkewSeconds = skew
    }
  }

  static get db(): Database {
    if (!PublisherManager._db) {
      throw new ConfigurationError(
        'PublisherManager not configured. Resolve it through the container first.'
      )
    }
    return PublisherManager._db
  }

  /** Tenant FK column name on the `publisher_credentials` table. */
  static get tenantFkColumn(): string {
    return PublisherManager._tenantFk ?? 'tenant_id'
  }

  /** Register a publisher instance (one per platform). */
  static register(publisher: Publisher): void {
    PublisherManager._publishers.set(publisher.name, publisher)
  }

  /** Look up a registered publisher by name; throws if absent. */
  static get(platform: string): Publisher {
    const publisher = PublisherManager._publishers.get(platform)
    if (!publisher) throw new PublisherNotRegisteredError(platform)
    return publisher
  }

  /** Whether a publisher is registered for the given platform. */
  static has(platform: string): boolean {
    return PublisherManager._publishers.has(platform)
  }

  /** Clear all registered publishers. For testing only. */
  static reset(): void {
    PublisherManager._publishers.clear()
  }

  /**
   * Dispatch a publish call: read credentials, refresh if expired, call
   * the publisher.
   *
   * Caller is responsible for ensuring the request is running inside the
   * appropriate tenant context (`withTenant(id, fn)`) when RLS is enabled.
   */
  static async publish(options: PublishDispatchOptions): Promise<PublishResult> {
    const publisher = PublisherManager.get(options.platform)

    const credentials = options.accountId
      ? await PublisherCredentials.find(options.tenantId, options.platform, options.accountId)
      : await PublisherCredentials.findOne(options.tenantId, options.platform)

    if (!credentials) {
      throw new CredentialsNotFoundError(String(options.tenantId), options.platform)
    }

    const refreshed = await PublisherManager.refreshIfExpired(publisher, credentials)
    return publisher.publish(refreshed, options.content)
  }

  /**
   * Internal: refresh tokens if expired, persist, return the latest credentials.
   * Exposed so durable workflows can refresh ahead of time.
   */
  static async refreshIfExpired(
    publisher: Publisher,
    credentials: import('./credentials/credentials.ts').PublisherCredentialsData
  ): Promise<import('./credentials/credentials.ts').PublisherCredentialsData> {
    if (!PublisherCredentials.isExpired(credentials, PublisherManager._refreshSkewSeconds)) {
      return credentials
    }
    if (!publisher.refresh) {
      // Token is expired and the publisher can't refresh — surface a clear error
      // so the caller knows to re-run the consent flow.
      throw new CredentialsRefreshError(
        String(credentials.tenantId),
        credentials.platform,
        'access token expired and publisher does not implement refresh()'
      )
    }
    let refreshed
    try {
      refreshed = await publisher.refresh(credentials)
    } catch (err) {
      throw new CredentialsRefreshError(
        String(credentials.tenantId),
        credentials.platform,
        (err as Error).message
      )
    }
    return PublisherCredentials.updateTokens(credentials.id, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken ?? null,
      expiresAt:
        refreshed.expiresIn !== undefined
          ? new Date(Date.now() + refreshed.expiresIn * 1000)
          : null,
    })
  }
}
