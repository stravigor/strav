import { inject } from '@strav/kernel/core/inject'
import Database from '../database'
import { ensureTenantTable } from './seed'

export interface TenantRecord {
  id: string
  slug: string
  name: string
  created_at: Date
  updated_at: Date
}

export interface TenantStats {
  tables: number
  totalRows: number
}

/**
 * Administer the built-in `tenant` registry.
 *
 * All operations route through the bypass connection so they are not
 * filtered by RLS policies. Use only from server-side admin paths
 * (the application code should never expose these directly to user input).
 */
@inject
export default class TenantManager {
  constructor(private db: Database) {}

  /** Ensure the `tenant` table exists. Safe to call repeatedly. */
  async setup(): Promise<void> {
    await ensureTenantTable(this.db.bypass)
  }

  /** Create a new tenant and return its row. */
  async create(input: { slug: string; name: string }): Promise<TenantRecord> {
    const rows = (await this.db.bypass.unsafe(
      `INSERT INTO "tenant" ("slug", "name") VALUES ($1, $2) RETURNING *`,
      [input.slug, input.name]
    )) as TenantRecord[]
    return rows[0]!
  }

  /** Delete a tenant. Cascades to tenant-scoped rows via FK ON DELETE CASCADE. */
  async delete(tenantId: string): Promise<void> {
    await this.db.bypass.unsafe(`DELETE FROM "tenant" WHERE "id" = $1`, [tenantId])
  }

  /** List all tenants ordered by creation time. */
  async list(): Promise<TenantRecord[]> {
    return (await this.db.bypass.unsafe(
      `SELECT * FROM "tenant" ORDER BY "created_at" ASC`
    )) as TenantRecord[]
  }

  /** Look up a tenant by id. */
  async find(tenantId: string): Promise<TenantRecord | null> {
    const rows = (await this.db.bypass.unsafe(
      `SELECT * FROM "tenant" WHERE "id" = $1 LIMIT 1`,
      [tenantId]
    )) as TenantRecord[]
    return rows[0] ?? null
  }

  /** Look up a tenant by slug. */
  async findBySlug(slug: string): Promise<TenantRecord | null> {
    const rows = (await this.db.bypass.unsafe(
      `SELECT * FROM "tenant" WHERE "slug" = $1 LIMIT 1`,
      [slug]
    )) as TenantRecord[]
    return rows[0] ?? null
  }

  async exists(tenantId: string): Promise<boolean> {
    return (await this.find(tenantId)) !== null
  }

  /** Aggregate stats: number of tenant-scoped tables and rows owned by this tenant. */
  async getStats(tenantId: string): Promise<TenantStats> {
    const tables = (await this.db.bypass.unsafe(
      `SELECT c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public'
           AND c.relkind = 'r'
           AND c.relrowsecurity = true`
    )) as Array<{ table_name: string }>

    let total = 0
    for (const t of tables) {
      const rows = (await this.db.bypass.unsafe(
        `SELECT COUNT(*)::int AS count FROM "${t.table_name}" WHERE "tenant_id" = $1`,
        [tenantId]
      )) as Array<{ count: number }>
      total += rows[0]?.count ?? 0
    }

    return { tables: tables.length, totalRows: total }
  }
}
