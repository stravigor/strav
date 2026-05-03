import { expect, test, describe, beforeAll, afterAll, beforeEach } from 'bun:test'
import { SQL } from 'bun'
import { Container } from '@strav/kernel/core'
import Configuration from '@strav/kernel/config/configuration'
import Database from '../src/database/database'
import {
  withTenant,
  withoutTenant,
  getCurrentTenantId,
  hasTenantContext,
  isBypassingTenant,
  TenantManager,
  ensureTenantTable,
  enableRLSStatements,
  createTenantPolicyStatement,
} from '../src/database/tenant'
import { transaction } from '../src/database'

const SUPERUSER = 'liva'
const SUPERUSER_PW = 'password1234'
const APP_ROLE = 'strav_test_app'
const APP_PW = 'strav_test_app_pw'

/**
 * RLS smoke tests for the multi-tenant flow.
 *
 * Setup uses the local `liva` superuser to provision a non-superuser
 * `strav_test_app` role (the one whose queries RLS will filter), then
 * configures Database with `strav_test_app` as the app pool and `liva`
 * (superuser → implicit BYPASSRLS) as the bypass pool.
 */
describe('Multi-tenant (RLS)', () => {
  let setupSql: SQL
  let container: Container
  let db: Database
  let manager: TenantManager
  let tenantA: { id: string; slug: string; name: string }
  let tenantB: { id: string; slug: string; name: string }

  beforeAll(async () => {
    setupSql = new SQL({
      hostname: '127.0.0.1',
      port: 5432,
      username: SUPERUSER,
      password: SUPERUSER_PW,
      database: 'strav_testing',
      max: 1,
    })

    // Provision a non-bypass app role used by the tenant-aware proxy.
    await setupSql.unsafe(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
          CREATE ROLE "${APP_ROLE}" LOGIN PASSWORD '${APP_PW}' NOBYPASSRLS;
        ELSE
          ALTER ROLE "${APP_ROLE}" NOBYPASSRLS LOGIN PASSWORD '${APP_PW}';
        END IF;
      END $$;
    `)
    await setupSql.unsafe(`GRANT ALL ON SCHEMA public TO "${APP_ROLE}"`)
    await setupSql.unsafe(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${APP_ROLE}"`
    )
    await setupSql.unsafe(
      `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "${APP_ROLE}"`
    )

    // Wipe any leftover artifacts from prior runs.
    await setupSql.unsafe(`DROP TABLE IF EXISTS "rls_post" CASCADE`)
    await setupSql.unsafe(`DROP TABLE IF EXISTS "tenant" CASCADE`)

    // Boot Database with the dual-pool config.
    const config = new Configuration({})
    config.set('database.host', '127.0.0.1')
    config.set('database.port', 5432)
    config.set('database.username', APP_ROLE)
    config.set('database.password', APP_PW)
    config.set('database.database', 'strav_testing')
    config.set('database.tenant.enabled', true)
    config.set('database.tenant.bypass.username', SUPERUSER)
    config.set('database.tenant.bypass.password', SUPERUSER_PW)

    container = new Container()
    container.singleton(Configuration, () => config)
    container.singleton(Database)
    container.singleton(TenantManager)

    db = container.resolve(Database)
    manager = container.resolve(TenantManager)

    await ensureTenantTable(db.bypass)
    // Make sure the app role can read the tenant FK target.
    await setupSql.unsafe(`GRANT SELECT ON "tenant" TO "${APP_ROLE}"`)

    // Create a tenanted test table (rls_post) using the tenant DDL helpers.
    await db.bypass.unsafe(`
      CREATE TABLE "rls_post" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "tenant_id" UUID NOT NULL DEFAULT current_setting('app.tenant_id', true)::uuid REFERENCES "tenant"("id") ON DELETE CASCADE,
        "title" VARCHAR(255) NOT NULL
      )
    `)
    for (const stmt of enableRLSStatements('rls_post')) {
      await db.bypass.unsafe(stmt)
    }
    await db.bypass.unsafe(createTenantPolicyStatement('rls_post'))
    await db.bypass.unsafe(`GRANT ALL ON "rls_post" TO "${APP_ROLE}"`)

    tenantA = await manager.create({ slug: 'rls-acme', name: 'Acme' })
    tenantB = await manager.create({ slug: 'rls-globex', name: 'Globex' })
  })

  afterAll(async () => {
    await db.bypass.unsafe(`DROP TABLE IF EXISTS "rls_post" CASCADE`)
    await db.bypass.unsafe(`DELETE FROM "tenant" WHERE "slug" IN ('rls-acme', 'rls-globex')`)
    await db.close()
    await setupSql.close()
  })

  beforeEach(async () => {
    await db.bypass.unsafe(`DELETE FROM "rls_post"`)
  })

  describe('Context', () => {
    test('withTenant sets and clears context', async () => {
      expect(hasTenantContext()).toBe(false)
      expect(getCurrentTenantId()).toBeNull()

      await withTenant(tenantA.id, async () => {
        expect(hasTenantContext()).toBe(true)
        expect(getCurrentTenantId()).toBe(tenantA.id)
      })

      expect(hasTenantContext()).toBe(false)
    })

    test('withoutTenant flags bypass mode', async () => {
      await withTenant(tenantA.id, async () => {
        expect(hasTenantContext()).toBe(true)
        await withoutTenant(async () => {
          expect(hasTenantContext()).toBe(false)
          expect(isBypassingTenant()).toBe(true)
          expect(getCurrentTenantId()).toBeNull()
        })
        expect(hasTenantContext()).toBe(true)
      })
    })

    test('rejects non-UUID tenant ids', async () => {
      await expect(withTenant('not-a-uuid', async () => 1)).rejects.toThrow(/Invalid tenant id/)
    })
  })

  describe('Isolation', () => {
    test('two tenants only see their own rows', async () => {
      await withTenant(tenantA.id, async () => {
        await db.sql.unsafe(`INSERT INTO "rls_post" ("title") VALUES ($1)`, ['from acme'])
      })
      await withTenant(tenantB.id, async () => {
        await db.sql.unsafe(`INSERT INTO "rls_post" ("title") VALUES ($1)`, ['from globex'])
      })

      const aRows = await withTenant(tenantA.id, async () =>
        db.sql.unsafe(`SELECT title FROM "rls_post"`)
      )
      const bRows = await withTenant(tenantB.id, async () =>
        db.sql.unsafe(`SELECT title FROM "rls_post"`)
      )

      expect(aRows).toHaveLength(1)
      expect((aRows as any)[0].title).toBe('from acme')
      expect(bRows).toHaveLength(1)
      expect((bRows as any)[0].title).toBe('from globex')
    })

    test('tenant_id auto-fills from app.tenant_id default', async () => {
      const inserted = await withTenant(tenantA.id, async () =>
        db.sql.unsafe(
          `INSERT INTO "rls_post" ("title") VALUES ($1) RETURNING "tenant_id"`,
          ['no explicit tenant']
        )
      )
      expect((inserted as any)[0].tenant_id).toBe(tenantA.id)
    })

    test('WITH CHECK rejects inserts targeting a different tenant', async () => {
      await expect(
        withTenant(tenantA.id, async () =>
          db.sql.unsafe(
            `INSERT INTO "rls_post" ("title", "tenant_id") VALUES ($1, $2)`,
            ['cross-tenant', tenantB.id]
          )
        )
      ).rejects.toThrow()
    })

    test('withoutTenant sees rows across tenants', async () => {
      await withTenant(tenantA.id, async () => {
        await db.sql.unsafe(`INSERT INTO "rls_post" ("title") VALUES ($1)`, ['acme'])
      })
      await withTenant(tenantB.id, async () => {
        await db.sql.unsafe(`INSERT INTO "rls_post" ("title") VALUES ($1)`, ['globex'])
      })

      const all = await withoutTenant(async () =>
        db.sql.unsafe(`SELECT title FROM "rls_post" ORDER BY title`)
      )
      expect(all).toHaveLength(2)
    })
  })

  describe('Transactions', () => {
    test('transaction propagates tenant context to nested queries', async () => {
      await withTenant(tenantA.id, async () => {
        await transaction(async tx => {
          await tx.unsafe(`INSERT INTO "rls_post" ("title") VALUES ($1)`, ['tx-1'])
          await tx.unsafe(`INSERT INTO "rls_post" ("title") VALUES ($1)`, ['tx-2'])
        })
      })

      const rows = await withTenant(tenantA.id, async () =>
        db.sql.unsafe(`SELECT title FROM "rls_post" ORDER BY title`)
      )
      expect(rows).toHaveLength(2)

      const otherRows = await withTenant(tenantB.id, async () =>
        db.sql.unsafe(`SELECT title FROM "rls_post"`)
      )
      expect(otherRows).toHaveLength(0)
    })
  })

  describe('TenantManager', () => {
    test('list returns created tenants', async () => {
      const slugs = (await manager.list()).map(t => t.slug)
      expect(slugs).toContain('rls-acme')
      expect(slugs).toContain('rls-globex')
    })

    test('findBySlug finds the tenant', async () => {
      const found = await manager.findBySlug('rls-acme')
      expect(found?.id).toBe(tenantA.id)
    })

    test('exists returns true for known tenant', async () => {
      expect(await manager.exists(tenantA.id)).toBe(true)
    })

    test('delete cascades tenant rows via FK', async () => {
      const ephemeral = await manager.create({ slug: 'rls-ephemeral', name: 'Ephemeral' })
      await withTenant(ephemeral.id, async () => {
        await db.sql.unsafe(`INSERT INTO "rls_post" ("title") VALUES ($1)`, ['will be deleted'])
      })
      await manager.delete(ephemeral.id)

      const orphans = await db.bypass.unsafe(
        `SELECT 1 FROM "rls_post" WHERE "tenant_id" = $1`,
        [ephemeral.id]
      )
      expect(orphans).toHaveLength(0)
    })
  })
})
