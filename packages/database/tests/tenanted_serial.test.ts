import { expect, test, describe, beforeAll, afterAll, beforeEach } from 'bun:test'
import { SQL } from 'bun'
import { Container } from '@strav/kernel/core'
import Configuration from '@strav/kernel/config/configuration'
import Database from '../src/database/database'
import {
  withTenant,
  withoutTenant,
  TenantManager,
  ensureTenantTable,
  ensureTenantSequencesObjects,
  enableRLSStatements,
  createTenantPolicyStatement,
} from '../src/database/tenant'
import defineSchema from '../src/schema/define_schema'
import { Archetype } from '../src/schema/types'
import t from '../src/schema/type_builder'
import RepresentationBuilder from '../src/schema/representation_builder'
import SqlGenerator from '../src/database/migration/sql_generator'
import SchemaDiffer from '../src/database/migration/differ'

const SUPERUSER = 'liva'
const SUPERUSER_PW = 'password1234'
const APP_ROLE = 'strav_test_app'
const APP_PW = 'strav_test_app_pw'

/**
 * Per-tenant ID sequences (`t.tenantedSerial()` / `t.tenantedBigSerial()`).
 * Same harness shape as tenant.test.ts: provision an NOBYPASSRLS app role and
 * route all app-pool queries through it.
 */
describe('Tenanted sequences (per-tenant numbering)', () => {
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

    await setupSql.unsafe(`DROP TABLE IF EXISTS "ts_order_item" CASCADE`)
    await setupSql.unsafe(`DROP TABLE IF EXISTS "ts_order" CASCADE`)
    await setupSql.unsafe(`DROP TABLE IF EXISTS "_strav_tenant_sequences" CASCADE`)
    await setupSql.unsafe(`DROP TABLE IF EXISTS "tenant" CASCADE`)
    await setupSql.unsafe(`DROP FUNCTION IF EXISTS strav_assign_tenanted_id() CASCADE`)

    const config = new Configuration({})
    config.set('database.host', '127.0.0.1')
    config.set('database.port', 5432)
    config.set('database.username', APP_ROLE)
    config.set('database.password', APP_PW)
    config.set('database.database', 'strav_testing')
    config.set('database.tenant.enabled', true)
    config.set('database.tenant.idType', 'uuid')
    config.set('database.tenant.bypass.username', SUPERUSER)
    config.set('database.tenant.bypass.password', SUPERUSER_PW)

    container = new Container()
    container.singleton(Configuration, () => config)
    container.singleton(Database)
    container.singleton(TenantManager)

    db = container.resolve(Database)
    manager = container.resolve(TenantManager)

    await ensureTenantTable(db.bypass, 'uuid')
    await ensureTenantSequencesObjects(db.bypass, 'uuid')

    await setupSql.unsafe(`GRANT SELECT ON "tenant" TO "${APP_ROLE}"`)
    await setupSql.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "_strav_tenant_sequences" TO "${APP_ROLE}"`
    )

    // Test table mirroring what the migration generator emits for
    //   defineSchema('ts_order', { tenanted: true,
    //     fields: { id: t.tenantedBigSerial().primaryKey(), title: t.string().required() }})
    await db.bypass.unsafe(`
      CREATE TABLE "ts_order" (
        "id" BIGINT NOT NULL,
        "tenant_id" UUID NOT NULL DEFAULT current_setting('app.tenant_id', true)::uuid REFERENCES "tenant"("id") ON DELETE CASCADE,
        "title" VARCHAR(255) NOT NULL,
        CONSTRAINT "pk_ts_order" PRIMARY KEY ("tenant_id", "id")
      )
    `)
    for (const stmt of enableRLSStatements('ts_order')) {
      await db.bypass.unsafe(stmt)
    }
    await db.bypass.unsafe(createTenantPolicyStatement('ts_order', 'uuid'))
    await db.bypass.unsafe(
      `CREATE TRIGGER "ts_order_assign_tenanted_id" BEFORE INSERT ON "ts_order" FOR EACH ROW EXECUTE FUNCTION strav_assign_tenanted_id();`
    )
    await db.bypass.unsafe(`GRANT ALL ON "ts_order" TO "${APP_ROLE}"`)

    // Child table with composite FK back to ts_order(tenant_id, id).
    await db.bypass.unsafe(`
      CREATE TABLE "ts_order_item" (
        "id" BIGINT NOT NULL,
        "tenant_id" UUID NOT NULL DEFAULT current_setting('app.tenant_id', true)::uuid REFERENCES "tenant"("id") ON DELETE CASCADE,
        "ts_order_id" BIGINT NOT NULL,
        "qty" INTEGER NOT NULL,
        CONSTRAINT "pk_ts_order_item" PRIMARY KEY ("tenant_id", "id"),
        CONSTRAINT "fk_ts_order_item_tenant_id_ts_order_id"
          FOREIGN KEY ("tenant_id", "ts_order_id") REFERENCES "ts_order" ("tenant_id", "id") ON DELETE CASCADE
      )
    `)
    for (const stmt of enableRLSStatements('ts_order_item')) {
      await db.bypass.unsafe(stmt)
    }
    await db.bypass.unsafe(createTenantPolicyStatement('ts_order_item', 'uuid'))
    await db.bypass.unsafe(
      `CREATE TRIGGER "ts_order_item_assign_tenanted_id" BEFORE INSERT ON "ts_order_item" FOR EACH ROW EXECUTE FUNCTION strav_assign_tenanted_id();`
    )
    await db.bypass.unsafe(`GRANT ALL ON "ts_order_item" TO "${APP_ROLE}"`)

    tenantA = await manager.create({ slug: 'ts-acme', name: 'Acme' })
    tenantB = await manager.create({ slug: 'ts-globex', name: 'Globex' })
  })

  afterAll(async () => {
    await db.bypass.unsafe(`DROP TABLE IF EXISTS "ts_order_item" CASCADE`)
    await db.bypass.unsafe(`DROP TABLE IF EXISTS "ts_order" CASCADE`)
    await db.bypass.unsafe(`DROP TABLE IF EXISTS "_strav_tenant_sequences" CASCADE`)
    await db.bypass.unsafe(`DROP FUNCTION IF EXISTS strav_assign_tenanted_id() CASCADE`)
    await db.bypass.unsafe(`DELETE FROM "tenant" WHERE "slug" IN ('ts-acme', 'ts-globex')`)
    await db.close()
    await setupSql.close()
  })

  beforeEach(async () => {
    await db.bypass.unsafe(`DELETE FROM "ts_order_item"`)
    await db.bypass.unsafe(`DELETE FROM "ts_order"`)
    await db.bypass.unsafe(`DELETE FROM "_strav_tenant_sequences"`)
  })

  describe('Per-tenant numbering', () => {
    test('each tenant starts at id=1 and increments independently', async () => {
      const aIds = await withTenant(tenantA.id, async () => {
        const ids: number[] = []
        for (const title of ['a1', 'a2', 'a3']) {
          const r = await db.sql.unsafe(
            `INSERT INTO "ts_order" ("title") VALUES ($1) RETURNING id`,
            [title]
          )
          ids.push(Number((r as any)[0].id))
        }
        return ids
      })

      const bIds = await withTenant(tenantB.id, async () => {
        const ids: number[] = []
        for (const title of ['b1', 'b2']) {
          const r = await db.sql.unsafe(
            `INSERT INTO "ts_order" ("title") VALUES ($1) RETURNING id`,
            [title]
          )
          ids.push(Number((r as any)[0].id))
        }
        return ids
      })

      expect(aIds).toEqual([1, 2, 3])
      expect(bIds).toEqual([1, 2])
    })

    test('counters do not collide across tenants', async () => {
      // Insert one row per tenant — both should be id=1.
      const aId = await withTenant(tenantA.id, async () => {
        const r = await db.sql.unsafe(
          `INSERT INTO "ts_order" ("title") VALUES ($1) RETURNING id`,
          ['only']
        )
        return Number((r as any)[0].id)
      })
      const bId = await withTenant(tenantB.id, async () => {
        const r = await db.sql.unsafe(
          `INSERT INTO "ts_order" ("title") VALUES ($1) RETURNING id`,
          ['only']
        )
        return Number((r as any)[0].id)
      })
      expect(aId).toBe(1)
      expect(bId).toBe(1)
    })
  })

  describe('Concurrency', () => {
    test('parallel inserts in the same tenant get unique sequential ids', async () => {
      const N = 25
      const ids = await withTenant(tenantA.id, async () => {
        const results = await Promise.all(
          Array.from({ length: N }, (_, i) =>
            db.sql.unsafe(`INSERT INTO "ts_order" ("title") VALUES ($1) RETURNING id`, [
              `t${i}`,
            ])
          )
        )
        return results.map((r: any) => Number(r[0].id))
      })

      expect(new Set(ids).size).toBe(N)
      expect(Math.min(...ids)).toBe(1)
      expect(Math.max(...ids)).toBe(N)
    })
  })

  describe('Rollback semantics', () => {
    test('rolled-back tx releases the counter (gap-free for committed work)', async () => {
      // Burn an id, then rollback the transaction.
      await withTenant(tenantA.id, async () => {
        await expect(
          db.sql.begin(async (tx: any) => {
            await tx.unsafe(`INSERT INTO "ts_order" ("title") VALUES ($1)`, ['will-rollback'])
            throw new Error('rollback')
          })
        ).rejects.toThrow('rollback')
      })

      // The next committed insert should still be id=1.
      const id = await withTenant(tenantA.id, async () => {
        const r = await db.sql.unsafe(
          `INSERT INTO "ts_order" ("title") VALUES ($1) RETURNING id`,
          ['ok']
        )
        return Number((r as any)[0].id)
      })
      expect(id).toBe(1)
    })
  })

  describe('Explicit id pass-through', () => {
    test('user-supplied id bypasses the trigger; counter is unaffected', async () => {
      await withTenant(tenantA.id, async () => {
        // Explicit id=100 — trigger leaves NEW.id alone.
        await db.sql.unsafe(
          `INSERT INTO "ts_order" ("id", "title") VALUES ($1, $2)`,
          [100, 'explicit']
        )

        // Auto-assigned id starts at 1 (counter never observed 100).
        const r = await db.sql.unsafe(
          `INSERT INTO "ts_order" ("title") VALUES ($1) RETURNING id`,
          ['auto']
        )
        expect(Number((r as any)[0].id)).toBe(1)
      })
    })
  })

  describe('Counter table RLS', () => {
    test('app role only sees its own tenant counters', async () => {
      // Burn one row per tenant.
      await withTenant(tenantA.id, async () => {
        await db.sql.unsafe(`INSERT INTO "ts_order" ("title") VALUES ($1)`, ['a'])
      })
      await withTenant(tenantB.id, async () => {
        await db.sql.unsafe(`INSERT INTO "ts_order" ("title") VALUES ($1)`, ['b'])
      })

      const aRows = await withTenant(tenantA.id, async () =>
        db.sql.unsafe(`SELECT tenant_id::text FROM "_strav_tenant_sequences"`)
      )
      expect(aRows).toHaveLength(1)
      expect((aRows as any)[0].tenant_id).toBe(tenantA.id)
    })
  })

  describe('Tenant deletion cascade', () => {
    test('deleting a tenant removes its counter rows', async () => {
      const tx = await manager.create({ slug: 'ts-temp', name: 'Temp' })
      await withTenant(tx.id, async () => {
        await db.sql.unsafe(`INSERT INTO "ts_order" ("title") VALUES ($1)`, ['t'])
      })

      const before = (await db.bypass.unsafe(
        `SELECT 1 FROM "_strav_tenant_sequences" WHERE "tenant_id" = $1`,
        [tx.id]
      )) as Array<unknown>
      expect(before).toHaveLength(1)

      await manager.delete(tx.id)

      const after = (await db.bypass.unsafe(
        `SELECT 1 FROM "_strav_tenant_sequences" WHERE "tenant_id" = $1`,
        [tx.id]
      )) as Array<unknown>
      expect(after).toHaveLength(0)
    })
  })

  describe('Composite foreign keys', () => {
    test('child references parent within the same tenant', async () => {
      await withTenant(tenantA.id, async () => {
        const orderRow = (await db.sql.unsafe(
          `INSERT INTO "ts_order" ("title") VALUES ($1) RETURNING id`,
          ['parent']
        )) as Array<{ id: bigint | number }>
        const orderId = Number(orderRow[0]!.id)

        await db.sql.unsafe(
          `INSERT INTO "ts_order_item" ("ts_order_id", "qty") VALUES ($1, $2)`,
          [orderId, 3]
        )

        const items = (await db.sql.unsafe(
          `SELECT ts_order_id, qty FROM "ts_order_item"`
        )) as Array<{ ts_order_id: bigint | number; qty: number }>
        expect(items).toHaveLength(1)
        expect(Number(items[0]!.ts_order_id)).toBe(orderId)
      })
    })

    test('cross-tenant child reference is rejected', async () => {
      // Parent in tenant A, child attempts in tenant B with the same numeric id.
      await withTenant(tenantA.id, async () => {
        await db.sql.unsafe(`INSERT INTO "ts_order" ("title") VALUES ($1)`, ['acme-1'])
      })

      await expect(
        withTenant(tenantB.id, async () => {
          await db.sql.unsafe(
            `INSERT INTO "ts_order_item" ("ts_order_id", "qty") VALUES ($1, $2)`,
            [1, 1]
          )
        })
      ).rejects.toThrow()
    })
  })

  describe('defineSchema validation', () => {
    test('tenantedSerial without tenanted: true throws', () => {
      expect(() =>
        defineSchema('bad_no_tenant', {
          archetype: Archetype.Entity,
          fields: {
            id: t.tenantedSerial().primaryKey(),
            title: t.string().required(),
          },
        })
      ).toThrow(/requires \{ tenanted: true \}/)
    })

    test('tenantedSerial without primaryKey() throws', () => {
      expect(() =>
        defineSchema('bad_no_pk', {
          tenanted: true,
          fields: {
            other: t.uuid().primaryKey(),
            seq: t.tenantedSerial(),
            title: t.string().required(),
          },
        })
      ).toThrow(/must be marked \.primaryKey\(\)/)
    })

    test('two tenantedSerial fields throws', () => {
      expect(() =>
        defineSchema('bad_two_seq', {
          tenanted: true,
          fields: {
            id: t.tenantedSerial().primaryKey(),
            other: t.tenantedBigSerial(),
          },
        })
      ).toThrow(/only one tenantedSerial/)
    })
  })
})

/**
 * Pure-function tests (no DB) — verify that RepresentationBuilder + SqlGenerator
 * produce the SQL we expect for both bigint and uuid tenant id types.
 */
describe('Tenanted sequences — schema/SQL generation', () => {
  function buildSql(idType: 'bigint' | 'uuid', schemas: ReturnType<typeof defineSchema>[]) {
    const rep = new RepresentationBuilder(schemas, idType).build()
    const diff = new SchemaDiffer().diff(rep, { enums: [], tables: [] })
    return new SqlGenerator(idType).generate(diff)
  }

  function tableSql(
    idType: 'bigint' | 'uuid',
    schemas: ReturnType<typeof defineSchema>[],
    name: string
  ): string {
    const generated = buildSql(idType, schemas)
    const table = generated.tables.get(name)
    if (!table) throw new Error(`expected generated SQL for table "${name}"`)
    return table.up
  }

  describe('Single tenanted-serial table', () => {
    const schema = defineSchema('order', {
      tenanted: true,
      fields: {
        id: t.tenantedBigSerial().primaryKey(),
        title: t.string().required(),
      },
    })

    test('bigint idType: emits BIGINT id, no SERIAL, composite PK, trigger, RLS', () => {
      const sql = tableSql('bigint', [schema], 'order')
      expect(sql).toContain('"id" BIGINT NOT NULL')
      expect(sql).not.toMatch(/"id"\s+(BIG)?SERIAL/i)
      expect(sql).toContain('"tenant_id" BIGINT NOT NULL')
      expect(sql).toContain(`current_setting('app.tenant_id', true)::bigint`)
      expect(sql).toContain('PRIMARY KEY ("tenant_id", "id")')
      expect(sql).toContain('ENABLE ROW LEVEL SECURITY')
      expect(sql).toMatch(/CREATE POLICY "tenant_isolation" ON "order"/)
      expect(sql).toContain(
        `CREATE TRIGGER "order_assign_tenanted_id" BEFORE INSERT ON "order" FOR EACH ROW EXECUTE FUNCTION strav_assign_tenanted_id();`
      )
    })

    test('uuid idType: emits UUID tenant_id with ::uuid cast', () => {
      const sql = tableSql('uuid', [schema], 'order')
      expect(sql).toContain('"id" BIGINT NOT NULL')
      expect(sql).toContain('"tenant_id" UUID NOT NULL')
      expect(sql).toContain(`current_setting('app.tenant_id', true)::uuid`)
      expect(sql).toContain('PRIMARY KEY ("tenant_id", "id")')
    })

    test('integer variant: t.tenantedSerial() emits INTEGER, not BIGINT', () => {
      const intSchema = defineSchema('thing', {
        tenanted: true,
        fields: {
          id: t.tenantedSerial().primaryKey(),
          name: t.string().required(),
        },
      })
      const sql = tableSql('bigint', [intSchema], 'thing')
      expect(sql).toContain('"id" INTEGER NOT NULL')
      expect(sql).not.toContain('"id" BIGINT')
    })
  })

  describe('Cross-table references', () => {
    test('parent FK to a tenanted-serial parent becomes composite (tenant_id, parent_id)', () => {
      const parent = defineSchema('order', {
        tenanted: true,
        fields: {
          id: t.tenantedBigSerial().primaryKey(),
          title: t.string().required(),
        },
      })
      const child = defineSchema('order_line', {
        archetype: Archetype.Component,
        tenanted: true,
        parents: ['order'],
        fields: {
          qty: t.integer().required(),
        },
      })

      // Composite FK is emitted via constraintsUp, not in the table's own up-SQL.
      const generated = buildSql('bigint', [parent, child])
      expect(generated.constraintsUp).toMatch(
        /FOREIGN KEY \("tenant_id", "order_id"\) REFERENCES "order" \("tenant_id", "id"\)/
      )
      // Composite index for the FK pair.
      expect(generated.indexesUp).toMatch(/ON "order_line" \("tenant_id", "order_id"\)/)
    })

    test('a non-tenanted child referencing a tenanted-serial parent throws', () => {
      const parent = defineSchema('order', {
        tenanted: true,
        fields: {
          id: t.tenantedBigSerial().primaryKey(),
          title: t.string().required(),
        },
      })
      const child = defineSchema('order_line', {
        archetype: Archetype.Component,
        // tenanted: false (default)
        parents: ['order'],
        fields: {
          qty: t.integer().required(),
        },
      })

      expect(() => buildSql('bigint', [parent, child])).toThrow(
        /Composite foreign keys require a tenant_id column on the child/
      )
    })
  })

  describe('Differ guardrails', () => {
    test('switching a column from serial to tenantedSerial throws (manual migration required)', () => {
      const before = defineSchema('order', {
        tenanted: true,
        fields: {
          id: t.serial().primaryKey(),
          title: t.string().required(),
        },
      })
      const after = defineSchema('order', {
        tenanted: true,
        fields: {
          id: t.tenantedBigSerial().primaryKey(),
          title: t.string().required(),
        },
      })
      const beforeRep = new RepresentationBuilder([before], 'bigint').build()
      const afterRep = new RepresentationBuilder([after], 'bigint').build()
      // The composite-PK shape also differs (single → composite). Even before
      // that surfaces, the column-type guard fires inside diffSingleColumn.
      expect(() => new SchemaDiffer().diff(afterRep, beforeRep)).toThrow(
        /Cannot migrate column "id"/
      )
    })
  })
})
