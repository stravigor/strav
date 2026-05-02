import type { SQL } from 'bun'
import type {
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookEndpointInput,
  WebhookEndpointPatch,
  WebhookStore,
} from '../types.ts'

/**
 * PostgreSQL-backed webhook store using `_strav_webhook_endpoints` and
 * `_strav_webhook_deliveries`. Both tables use UUID PKs (`gen_random_uuid()`)
 * because endpoint and delivery ids appear in HTTP headers / external
 * customer payloads — opaque, non-guessable identifiers are better suited.
 */
export class DatabaseWebhookStore implements WebhookStore {
  readonly name = 'database'

  constructor(private sql: SQL) {}

  async ensureTables(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS "_strav_webhook_endpoints" (
        "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "url"         TEXT NOT NULL,
        "secret"      TEXT NOT NULL,
        "events"      TEXT[] NOT NULL,
        "active"      BOOLEAN NOT NULL DEFAULT TRUE,
        "description" TEXT,
        "created_at"  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
    await this.sql`
      CREATE TABLE IF NOT EXISTS "_strav_webhook_deliveries" (
        "id"              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "endpoint_id"     UUID NOT NULL REFERENCES "_strav_webhook_endpoints"("id") ON DELETE CASCADE,
        "event"           VARCHAR(128) NOT NULL,
        "payload"         JSONB NOT NULL,
        "status"          VARCHAR(16) NOT NULL DEFAULT 'pending',
        "attempts"        INT NOT NULL DEFAULT 0,
        "last_error"      TEXT,
        "response_status" INT,
        "response_body"   TEXT,
        "signed_at"       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "delivered_at"    TIMESTAMPTZ,
        "next_retry_at"   TIMESTAMPTZ
      )
    `
    await this.sql`
      CREATE INDEX IF NOT EXISTS "idx_strav_webhook_deliveries_endpoint"
        ON "_strav_webhook_deliveries" ("endpoint_id", "status", "signed_at" DESC)
    `
    await this.sql`
      CREATE INDEX IF NOT EXISTS "idx_strav_webhook_deliveries_pending"
        ON "_strav_webhook_deliveries" ("status", "next_retry_at")
        WHERE "status" = 'pending'
    `
  }

  async createEndpoint(input: WebhookEndpointInput): Promise<WebhookEndpoint> {
    const rows = await this.sql`
      INSERT INTO "_strav_webhook_endpoints"
        ("url", "secret", "events", "active", "description")
      VALUES
        (${input.url}, ${input.secret}, ${input.events as unknown as string},
         ${input.active ?? true}, ${input.description ?? null})
      RETURNING *
    `
    return hydrateEndpoint(rows[0] as Record<string, unknown>)
  }

  async getEndpoint(id: string): Promise<WebhookEndpoint | null> {
    const rows = await this.sql`
      SELECT * FROM "_strav_webhook_endpoints" WHERE "id" = ${id}
    `
    return rows.length === 0 ? null : hydrateEndpoint(rows[0] as Record<string, unknown>)
  }

  async listEndpoints(): Promise<WebhookEndpoint[]> {
    const rows = await this.sql`
      SELECT * FROM "_strav_webhook_endpoints" ORDER BY "created_at" ASC
    `
    return rows.map((r: Record<string, unknown>) => hydrateEndpoint(r))
  }

  async updateEndpoint(
    id: string,
    patch: WebhookEndpointPatch
  ): Promise<WebhookEndpoint | null> {
    const existing = await this.getEndpoint(id)
    if (!existing) return null
    const next: WebhookEndpoint = {
      ...existing,
      ...patch,
      events: patch.events ?? existing.events,
    }
    await this.sql`
      UPDATE "_strav_webhook_endpoints"
      SET "url" = ${next.url},
          "secret" = ${next.secret},
          "events" = ${next.events as unknown as string},
          "active" = ${next.active},
          "description" = ${next.description ?? null}
      WHERE "id" = ${id}
    `
    return next
  }

  async deleteEndpoint(id: string): Promise<void> {
    await this.sql`DELETE FROM "_strav_webhook_endpoints" WHERE "id" = ${id}`
  }

  async endpointsForEvent(event: string): Promise<WebhookEndpoint[]> {
    const rows = await this.sql`
      SELECT * FROM "_strav_webhook_endpoints"
      WHERE "active" = TRUE
        AND ('*' = ANY("events") OR ${event} = ANY("events"))
      ORDER BY "created_at" ASC
    `
    return rows.map((r: Record<string, unknown>) => hydrateEndpoint(r))
  }

  async createDelivery(input: {
    endpointId: string
    event: string
    payload: unknown
  }): Promise<WebhookDelivery> {
    const rows = await this.sql`
      INSERT INTO "_strav_webhook_deliveries"
        ("endpoint_id", "event", "payload")
      VALUES
        (${input.endpointId}, ${input.event}, ${JSON.stringify(input.payload)}::jsonb)
      RETURNING *
    `
    return hydrateDelivery(rows[0] as Record<string, unknown>)
  }

  async getDelivery(id: string): Promise<WebhookDelivery | null> {
    const rows = await this.sql`
      SELECT * FROM "_strav_webhook_deliveries" WHERE "id" = ${id}
    `
    return rows.length === 0 ? null : hydrateDelivery(rows[0] as Record<string, unknown>)
  }

  async updateDelivery(
    id: string,
    patch: Partial<Omit<WebhookDelivery, 'id' | 'endpointId' | 'event' | 'payload'>>
  ): Promise<WebhookDelivery | null> {
    const current = await this.getDelivery(id)
    if (!current) return null
    const next = { ...current, ...patch }
    await this.sql`
      UPDATE "_strav_webhook_deliveries"
      SET "status" = ${next.status},
          "attempts" = ${next.attempts},
          "last_error" = ${next.lastError ?? null},
          "response_status" = ${next.responseStatus ?? null},
          "response_body" = ${next.responseBody ?? null},
          "delivered_at" = ${next.deliveredAt ?? null},
          "next_retry_at" = ${next.nextRetryAt ?? null}
      WHERE "id" = ${id}
    `
    return next
  }

  async forEndpoint(
    endpointId: string,
    opts?: { status?: WebhookDeliveryStatus; limit?: number }
  ): Promise<WebhookDelivery[]> {
    const status = opts?.status
    const limit = opts?.limit ?? 100
    const rows = status
      ? await this.sql`
          SELECT * FROM "_strav_webhook_deliveries"
          WHERE "endpoint_id" = ${endpointId} AND "status" = ${status}
          ORDER BY "signed_at" DESC LIMIT ${limit}
        `
      : await this.sql`
          SELECT * FROM "_strav_webhook_deliveries"
          WHERE "endpoint_id" = ${endpointId}
          ORDER BY "signed_at" DESC LIMIT ${limit}
        `
    return rows.map((r: Record<string, unknown>) => hydrateDelivery(r))
  }

  async reset(): Promise<void> {
    await this.sql`TRUNCATE TABLE "_strav_webhook_deliveries"`
    await this.sql`TRUNCATE TABLE "_strav_webhook_endpoints" CASCADE`
  }
}

function hydrateEndpoint(row: Record<string, unknown>): WebhookEndpoint {
  return {
    id: row.id as string,
    url: row.url as string,
    secret: row.secret as string,
    events: (row.events as string[]) ?? [],
    active: row.active as boolean,
    description: (row.description as string | null) ?? undefined,
    createdAt: row.created_at as Date,
  }
}

function hydrateDelivery(row: Record<string, unknown>): WebhookDelivery {
  return {
    id: row.id as string,
    endpointId: row.endpoint_id as string,
    event: row.event as string,
    payload: parseJson(row.payload),
    status: row.status as WebhookDeliveryStatus,
    attempts: Number(row.attempts ?? 0),
    lastError: (row.last_error as string | null) ?? undefined,
    responseStatus: (row.response_status as number | null) ?? undefined,
    responseBody: (row.response_body as string | null) ?? undefined,
    signedAt: row.signed_at as Date,
    deliveredAt: (row.delivered_at as Date | null) ?? undefined,
    nextRetryAt: (row.next_retry_at as Date | null) ?? undefined,
  }
}

function parseJson<T>(raw: unknown): T {
  if (raw === null || raw === undefined) return raw as T
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T
    } catch {
      return raw as T
    }
  }
  return raw as T
}
