import { defineSchema, t, Archetype } from '@strav/database/schema'

/**
 * Per-tenant OAuth / API credentials for a single publishing platform.
 *
 * One row per (tenant, platform, account_id) — a single tenant can have
 * multiple Facebook Pages or multiple GBP locations and each gets its
 * own row.
 *
 * `tenanted: true` injects the `<tenant>_id` column and RLS policy so
 * @strav/database's `withTenant(id, fn)` automatically scopes reads and
 * writes.
 *
 * `accessToken` and `refreshToken` are stored encrypted (enc:v1: sentinel
 * prefix, see PublisherCredentials.create / .updateTokens). The schema's
 * `sensitive()` marker disables them from default logging surfaces.
 */
export default defineSchema('publisher_credentials', {
  archetype: Archetype.Component,
  tenanted: true,
  fields: {
    platform: t.varchar(50).required().index(),
    /**
     * Platform-side account identifier. Examples:
     *   - google_business: location ID (`locations/123`)
     *   - meta:            Facebook Page ID
     *   - wordpress:       site URL host
     *   - line_broadcast:  LINE channel ID
     *
     * Combined with (tenant_id, platform) to form a logical uniqueness
     * key — apps that need a DB-level UNIQUE can add it in a migration.
     */
    accountId: t.varchar(255).required().index(),
    accessToken: t.text().required().sensitive(),
    refreshToken: t.text().nullable().sensitive(),
    expiresAt: t.timestamptz().nullable(),
    scopes: t.jsonb().nullable(),
    /**
     * Platform-specific structured data. Examples:
     *   - meta:            { ig_account_id, page_name }
     *   - google_business: { account_id, location_name }
     *   - wordpress:       { site_url, username, application_password_hint }
     */
    metadata: t.jsonb().nullable(),
  },
})
