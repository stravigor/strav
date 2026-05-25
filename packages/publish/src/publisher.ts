import type { PublishContent, PublishResult, RefreshedTokens } from './types.ts'
import type { PublisherCredentialsData } from './credentials/credentials.ts'

/**
 * Contract every publisher implements.
 *
 * `name` is the registration key used by PublisherManager — the four
 * built-ins use the canonical PublisherName values
 * ('google_business' | 'meta' | 'wordpress' | 'line_broadcast') but a
 * custom publisher can use any string.
 *
 * `publish` performs the platform-specific API call and returns a
 * normalized PublishResult. Throw PublishError on failure.
 *
 * `refresh` is optional — implement it for platforms with OAuth refresh
 * tokens. PublisherManager calls it automatically when a credential's
 * `expiresAt` is in the past (or within the refresh-skew window) before
 * dispatching the publish call. Platforms with non-expiring credentials
 * (WordPress Application Passwords, LINE long-lived channel tokens) can
 * leave this undefined.
 */
export interface Publisher {
  readonly name: string

  publish(credentials: PublisherCredentialsData, content: PublishContent): Promise<PublishResult>

  refresh?(credentials: PublisherCredentialsData): Promise<RefreshedTokens>
}
