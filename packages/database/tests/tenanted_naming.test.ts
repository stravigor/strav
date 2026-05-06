import { expect, test, describe, beforeAll, afterAll, beforeEach } from 'bun:test'
import { SQL } from 'bun'
import { Container } from '@strav/kernel/core'
import Configuration from '@strav/kernel/config/configuration'
import Database from '../src/database/database'
import {
  withTenant,
  TenantManager,
  validateTenantTableName,
  tenantFkColumnFor,
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
 * Pure-function tests — verify the schema/SQL generation honours a custom
 * tenant table name end-to-end.
 */
describe('Configurable tenant table name — schema/SQL generation', () => {
  function buildSql(
    idType: 'bigint' | 'uuid',
    tableName: string,
    schemas: ReturnType<typeof defineSchema>[]
  ) {
    const fkCol = tenantFkColumnFor(tableName)
    const rep = new RepresentationBuilder(schemas, idType, tableName, fkCol).build()
    const diff = new SchemaDiffer().diff(rep, { enums: [], tables: [] })
    return new SqlGenerator(idType, tableName, fkCol).generate(diff)
  }

  function tableSql(
    idType: 'bigint' | 'uuid',
    tableName: string,
    schemas: ReturnType<typeof defineSchema>[],
    name: string
  ): string {
    const generated = buildSql(idType, tableName, schemas)
    const out = generated.tables.get(name)
    if (!out) throw new Error(`expected generated SQL for table "${name}"`)
    return out.up
  }

  test('tenanted column is named <tableName>_id and references <tableName>', () => {
    const schema = defineSchema('post', {
      tenanted: true,
      fields: { title: t.string().required() },
    })
    const sql = tableSql('uuid', 'workspace', [schema], 'post')
    expect(sql).toContain('"workspace_id" UUID NOT NULL')
    expect(sql).not.toMatch(/"tenant_id"/)
    // The column DEFAULT still uses the framework-internal session var name.
    expect(sql).toContain(`current_setting('app.tenant_id', true)::uuid`)
    // RLS policy uses the renamed column.
    expect(sql).toMatch(/USING \("workspace_id" = current_setting/)
    expect(sql).toMatch(/WITH CHECK \("workspace_id" = current_setting/)
  })

  test('tenantedSerial composite PK is (workspace_id, id) and trigger gets the column arg', () => {
    const schema = defineSchema('order', {
      tenanted: true,
      fields: {
        id: t.tenantedBigSerial().primaryKey(),
        total: t.decimal(10, 2).required(),
      },
    })
    const sql = tableSql('bigint', 'workspace', [schema], 'order')
    expect(sql).toContain('"id" BIGINT NOT NULL')
    expect(sql).toContain('PRIMARY KEY ("workspace_id", "id")')
    expect(sql).toContain(
      `CREATE TRIGGER "order_assign_tenanted_id" BEFORE INSERT ON "order" FOR EACH ROW EXECUTE FUNCTION strav_assign_tenanted_id('workspace_id');`
    )
  })

  test('child FK to a tenantedSerial parent uses (workspace_id, …)', () => {
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
    const generated = buildSql('bigint', 'workspace', [parent, child])
    expect(generated.constraintsUp).toMatch(
      /FOREIGN KEY \("workspace_id", "order_id"\) REFERENCES "order" \("workspace_id", "id"\)/
    )
    expect(generated.indexesUp).toMatch(/ON "order_line" \("workspace_id", "order_id"\)/)
  })

  test('tenant FK target is the configured table name', () => {
    const schema = defineSchema('post', {
      tenanted: true,
      fields: { title: t.string().required() },
    })
    const generated = buildSql('uuid', 'workspace', [schema])
    expect(generated.constraintsUp).toMatch(
      /FOREIGN KEY \("workspace_id"\) REFERENCES "workspace" \("id"\)/
    )
  })
})

/**
 * Schema-based tenant configuration — derive name + idType from a
 * `tenantRegistry: true` schema, and validate the registry guards.
 */
describe('Tenant schema marker (tenantRegistry)', () => {
  // Bun runs each test file in its own process, but the SchemaRegistry
  // module-state propagation is sticky within this file. Use throwaway
  // registry instances per test.
  test('register() propagates tableName + idType to module state', async () => {
    const SchemaRegistry = (await import('../src/schema/registry')).default
    const { getTenantTableName } = await import('../src/database/tenant/naming')
    const { getTenantIdType } = await import('../src/database/tenant/id_type')

    const reg = new SchemaRegistry()
    reg.register(
      defineSchema('workspace', {
        archetype: Archetype.Entity,
        tenantRegistry: true,
        fields: {
          id: t.serial().primaryKey(),
          slug: t.string().unique().required(),
          name: t.string().required(),
        },
      })
    )

    expect(reg.tenantSchema()?.name).toBe('workspace')
    expect(reg.tenantTableName()).toBe('workspace')
    expect(reg.tenantIdType()).toBe('integer')
    expect(getTenantTableName()).toBe('workspace')
    expect(getTenantIdType()).toBe('integer')
  })

  test('rejects two schemas with tenantRegistry: true', async () => {
    const SchemaRegistry = (await import('../src/schema/registry')).default
    const reg = new SchemaRegistry()
    reg.register(
      defineSchema('one', {
        archetype: Archetype.Entity,
        tenantRegistry: true,
        fields: { id: t.bigserial().primaryKey() },
      })
    )
    expect(() =>
      reg.register(
        defineSchema('two', {
          archetype: Archetype.Entity,
          tenantRegistry: true,
          fields: { id: t.bigserial().primaryKey() },
        })
      )
    ).toThrow(/Only one is allowed/)
  })

  test('validate() throws if a tenanted schema exists but no tenantRegistry', async () => {
    const SchemaRegistry = (await import('../src/schema/registry')).default
    const reg = new SchemaRegistry()
    reg.register(
      defineSchema('post', {
        archetype: Archetype.Entity,
        tenanted: true,
        fields: { title: t.string().required() },
      })
    )
    expect(() => reg.validate()).toThrow(/no tenant registry schema is registered/)
  })

  test('defineSchema rejects tenantRegistry on a schema without a PK', () => {
    expect(() =>
      defineSchema('bad', {
        archetype: Archetype.Entity,
        tenantRegistry: true,
        fields: {
          slug: t.string().required(),
        },
      })
    ).toThrow(/exactly one primary key/)
  })

  test('defineSchema rejects tenantRegistry with a non-serial/non-uuid PK', () => {
    expect(() =>
      defineSchema('bad', {
        archetype: Archetype.Entity,
        tenantRegistry: true,
        fields: {
          id: t.string().primaryKey(),
        },
      })
    ).toThrow(/PK must be t\.serial\(\)/)
  })
})

describe('Tenant id type derivation', () => {
  test('serial / smallserial / bigserial / uuid map correctly', async () => {
    const { tenantIdTypeFromPgType } = await import('../src/database/tenant/id_type')
    expect(tenantIdTypeFromPgType('serial')).toBe('integer')
    expect(tenantIdTypeFromPgType('smallserial')).toBe('integer')
    expect(tenantIdTypeFromPgType('bigserial')).toBe('bigint')
    expect(tenantIdTypeFromPgType('uuid')).toBe('uuid')
  })

  test('rejects unsupported pgTypes', async () => {
    const { tenantIdTypeFromPgType } = await import('../src/database/tenant/id_type')
    expect(() => tenantIdTypeFromPgType('text')).toThrow(/Cannot derive tenant id type/)
    expect(() => tenantIdTypeFromPgType('integer')).toThrow(/Cannot derive tenant id type/)
  })
})

describe('SERIAL tenant PK end-to-end (SQL gen)', () => {
  function buildSql(schemas: ReturnType<typeof defineSchema>[]) {
    const rep = new RepresentationBuilder(schemas, 'integer', 'tenant', 'tenant_id').build()
    const diff = new SchemaDiffer().diff(rep, { enums: [], tables: [] })
    return new SqlGenerator('integer', 'tenant', 'tenant_id').generate(diff)
  }

  test('tenanted child gets INTEGER tenant_id (not BIGINT)', () => {
    const tenantSchema = defineSchema('tenant', {
      archetype: Archetype.Entity,
      tenantRegistry: true,
      fields: {
        id: t.serial().primaryKey(),
        slug: t.string().unique().required(),
        name: t.string().required(),
      },
    })
    const post = defineSchema('post', {
      archetype: Archetype.Entity,
      tenanted: true,
      fields: { title: t.string().required() },
    })
    const generated = buildSql([tenantSchema, post])
    const tenantUp = generated.tables.get('tenant')!.up
    const postUp = generated.tables.get('post')!.up
    expect(tenantUp).toContain('"id" SERIAL')
    expect(postUp).toContain('"tenant_id" INTEGER NOT NULL')
    expect(postUp).toContain(`current_setting('app.tenant_id', true)::integer`)
    expect(postUp).toMatch(/USING \("tenant_id" = current_setting\([^)]+\)::integer\)/)
  })
})

describe('validateTenantTableName', () => {
  test('accepts plain snake_case identifiers', () => {
    expect(() => validateTenantTableName('tenant')).not.toThrow()
    expect(() => validateTenantTableName('workspace')).not.toThrow()
    expect(() => validateTenantTableName('organization_unit')).not.toThrow()
    expect(() => validateTenantTableName('_internal')).not.toThrow()
  })

  test('rejects unsafe inputs', () => {
    expect(() => validateTenantTableName('Workspace')).toThrow(/Invalid tenant table name/)
    expect(() => validateTenantTableName('1bad')).toThrow(/Invalid tenant table name/)
    expect(() => validateTenantTableName('bad-name')).toThrow(/Invalid tenant table name/)
    expect(() => validateTenantTableName('drop table; --')).toThrow(/Invalid tenant table name/)
    expect(() => validateTenantTableName('"injection"')).toThrow(/Invalid tenant table name/)
  })
})

/**
 * DB integration test — boot Database with a custom tenant.tableName and
 * verify the table is created with the configured name, the tenant FK column
 * is renamed everywhere, and TenantManager / withTenant work end-to-end.
 */
describe('Configurable tenant table name — DB integration', () => {
  let setupSql: SQL
  let container: Container
  let db: Database
  let manager: TenantManager
  let workspaceA: { id: string; slug: string; name: string }
  let workspaceB: { id: string; slug: string; name: string }

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

    await setupSql.unsafe(`DROP TABLE IF EXISTS "tn_project" CASCADE`)
    await setupSql.unsafe(`DROP TABLE IF EXISTS "_strav_tenant_sequences" CASCADE`)
    await setupSql.unsafe(`DROP TABLE IF EXISTS "workspace" CASCADE`)
    await setupSql.unsafe(`DROP FUNCTION IF EXISTS strav_assign_tenanted_id() CASCADE`)

    const config = new Configuration({})
    config.set('database.host', '127.0.0.1')
    config.set('database.port', 5432)
    config.set('database.username', APP_ROLE)
    config.set('database.password', APP_PW)
    config.set('database.database', 'strav_testing')
    config.set('database.tenant.enabled', true)
    config.set('database.tenant.bypass.username', SUPERUSER)
    config.set('database.tenant.bypass.password', SUPERUSER_PW)

    // Register a custom tenant schema (named 'workspace', UUID PK).
    const SchemaRegistry = (await import('../src/schema/registry')).default
    new SchemaRegistry().register(
      defineSchema('workspace', {
        archetype: Archetype.Entity,
        tenantRegistry: true,
        fields: {
          id: t.uuid().primaryKey(),
          slug: t.string().unique().required(),
          name: t.string().required(),
        },
      })
    )

    container = new Container()
    container.singleton(Configuration, () => config)
    container.singleton(Database)
    container.singleton(TenantManager)

    db = container.resolve(Database)
    manager = container.resolve(TenantManager)

    expect(db.tenantTableName).toBe('workspace')
    expect(db.tenantFkColumn).toBe('workspace_id')

    // ensureTenantTable creates the registry table directly (test fixture);
    // production apps would create it via a migration.
    const { ensureTenantTable } = await import('../src/database/tenant')
    await ensureTenantTable(db.bypass, 'uuid', 'workspace')
    await manager.setup()

    await setupSql.unsafe(`GRANT SELECT ON "workspace" TO "${APP_ROLE}"`)
    await setupSql.unsafe(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON "_strav_tenant_sequences" TO "${APP_ROLE}"`
    )

    // Tenanted child table that mirrors what the migration generator would
    // emit for a defineSchema('tn_project', { tenanted: true, fields: { ... } }).
    await db.bypass.unsafe(`
      CREATE TABLE "tn_project" (
        "id" BIGINT NOT NULL,
        "workspace_id" UUID NOT NULL DEFAULT current_setting('app.tenant_id', true)::uuid REFERENCES "workspace"("id") ON DELETE CASCADE,
        "title" VARCHAR(255) NOT NULL,
        CONSTRAINT "pk_tn_project" PRIMARY KEY ("workspace_id", "id")
      )
    `)
    await db.bypass.unsafe(`ALTER TABLE "tn_project" ENABLE ROW LEVEL SECURITY`)
    await db.bypass.unsafe(`ALTER TABLE "tn_project" FORCE ROW LEVEL SECURITY`)
    await db.bypass.unsafe(
      `CREATE POLICY "tenant_isolation" ON "tn_project" USING ("workspace_id" = current_setting('app.tenant_id', true)::uuid) WITH CHECK ("workspace_id" = current_setting('app.tenant_id', true)::uuid)`
    )
    await db.bypass.unsafe(
      `CREATE TRIGGER "tn_project_assign_tenanted_id" BEFORE INSERT ON "tn_project" FOR EACH ROW EXECUTE FUNCTION strav_assign_tenanted_id('workspace_id')`
    )
    await db.bypass.unsafe(`GRANT ALL ON "tn_project" TO "${APP_ROLE}"`)

    workspaceA = await manager.create({ slug: 'tn-acme', name: 'Acme' })
    workspaceB = await manager.create({ slug: 'tn-globex', name: 'Globex' })
  })

  afterAll(async () => {
    await db.bypass.unsafe(`DROP TABLE IF EXISTS "tn_project" CASCADE`)
    await db.bypass.unsafe(`DROP TABLE IF EXISTS "_strav_tenant_sequences" CASCADE`)
    await db.bypass.unsafe(`DROP FUNCTION IF EXISTS strav_assign_tenanted_id() CASCADE`)
    await db.bypass.unsafe(`DELETE FROM "workspace" WHERE "slug" IN ('tn-acme', 'tn-globex')`)
    await db.close()
    await setupSql.close()
  })

  beforeEach(async () => {
    await db.bypass.unsafe(`DELETE FROM "tn_project"`)
    await db.bypass.unsafe(`DELETE FROM "_strav_tenant_sequences"`)
  })

  test('TenantManager queries the configured table', async () => {
    const all = await manager.list()
    expect(all.map(t => t.slug).sort()).toEqual(['tn-acme', 'tn-globex'])
    const a = await manager.findBySlug('tn-acme')
    expect(a?.id).toBe(workspaceA.id)
  })

  test('tenanted-serial trigger uses the configured FK column', async () => {
    const aIds = await withTenant(workspaceA.id, async () => {
      const ids: number[] = []
      for (const title of ['p1', 'p2']) {
        const r = await db.sql.unsafe(
          `INSERT INTO "tn_project" ("title") VALUES ($1) RETURNING id, workspace_id`,
          [title]
        )
        const row = (r as any)[0]
        expect(row.workspace_id).toBe(workspaceA.id)
        ids.push(Number(row.id))
      }
      return ids
    })
    expect(aIds).toEqual([1, 2])

    const bIds = await withTenant(workspaceB.id, async () => {
      const r = await db.sql.unsafe(
        `INSERT INTO "tn_project" ("title") VALUES ($1) RETURNING id, workspace_id`,
        ['only']
      )
      return [Number((r as any)[0].id)]
    })
    expect(bIds).toEqual([1])
  })

  test('cross-tenant insert is rejected by the policy', async () => {
    await expect(
      withTenant(workspaceA.id, async () =>
        db.sql.unsafe(
          `INSERT INTO "tn_project" ("title", "workspace_id") VALUES ($1, $2)`,
          ['cross', workspaceB.id]
        )
      )
    ).rejects.toThrow()
  })
})
