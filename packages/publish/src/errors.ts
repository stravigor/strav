/**
 * Package-specific errors.
 *
 * Distinct from kernel's ExternalServiceError so callers can branch on
 * publish vs. credential-store failures without checking message strings.
 * Each subclass keeps a reference to the underlying provider name and
 * (where relevant) the offending tenant + platform.
 */

export class PublishError extends Error {
  readonly platform: string
  readonly status?: number
  readonly raw?: unknown

  constructor(platform: string, message: string, opts?: { status?: number; raw?: unknown }) {
    super(`[${platform}] ${message}`)
    this.name = 'PublishError'
    this.platform = platform
    this.status = opts?.status
    this.raw = opts?.raw
  }
}

export class CredentialsNotFoundError extends Error {
  readonly tenantId: string
  readonly platform: string

  constructor(tenantId: string, platform: string) {
    super(`No publish credentials for tenant ${tenantId} on ${platform}. Connect the account first.`)
    this.name = 'CredentialsNotFoundError'
    this.tenantId = tenantId
    this.platform = platform
  }
}

export class CredentialsRefreshError extends Error {
  readonly tenantId: string
  readonly platform: string

  constructor(tenantId: string, platform: string, reason: string) {
    super(`Failed to refresh credentials for tenant ${tenantId} on ${platform}: ${reason}`)
    this.name = 'CredentialsRefreshError'
    this.tenantId = tenantId
    this.platform = platform
  }
}

export class PublisherNotRegisteredError extends Error {
  constructor(platform: string) {
    super(
      `No publisher registered for "${platform}". Register a Publisher via PublisherManager.register().`
    )
    this.name = 'PublisherNotRegisteredError'
  }
}
