import type { PublisherCredentialsData } from '../src/credentials/credentials.ts'

/**
 * Build a fake PublisherCredentialsData record for adapter tests, with
 * sane defaults that can be overridden per-test.
 *
 * Note this skips the encrypt/decrypt round-trip — adapter tests don't
 * exercise the DB-backed persistence path; they call publish() directly
 * with a plain plaintext access token.
 */
export function makeCredentials(
  overrides: Partial<PublisherCredentialsData> = {}
): PublisherCredentialsData {
  return {
    id: 1,
    tenantId: 'tenant-1',
    platform: 'test',
    accountId: 'account-1',
    accessToken: 'access-token',
    refreshToken: null,
    expiresAt: null,
    scopes: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}
