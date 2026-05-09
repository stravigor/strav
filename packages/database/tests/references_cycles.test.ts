import { expect, test, describe } from 'bun:test'
import defineSchema from '../src/schema/define_schema'
import { Archetype } from '../src/schema/types'
import t from '../src/schema/type_builder'
import RepresentationBuilder from '../src/schema/representation_builder'
import SqlGenerator from '../src/database/migration/sql_generator'
import SchemaDiffer from '../src/database/migration/differ'
import SchemaRegistry from '../src/schema/registry'
import type { DatabaseRepresentation } from '../src/schema/database_representation'
import type { SchemaDefinition } from '../src/schema/types'

const EMPTY_REP: DatabaseRepresentation = { extensions: [], enums: [], tables: [] }

function build(schemas: SchemaDefinition[]) {
  const rep = new RepresentationBuilder(schemas).build()
  const diff = new SchemaDiffer().diff(rep, EMPTY_REP)
  const sql = new SqlGenerator().generate(diff)
  return { rep, diff, sql }
}

describe('Self-referential FK via t.reference', () => {
  test('non-tenanted self-FK (category tree) emits a single-column FK', () => {
    const category = defineSchema('category', {
      fields: {
        id: t.bigserial().primaryKey(),
        name: t.varchar(120).required(),
        parent: t.reference('category').nullable(),
      },
    })

    const { rep, sql } = build([category])
    const table = rep.tables.find(t => t.name === 'category')!

    expect(table.columns.find(c => c.name === 'parent_id')).toBeDefined()
    const fk = table.foreignKeys.find(
      f =>
        f.columns.length === 1 &&
        f.columns[0] === 'parent_id' &&
        f.referencedTable === 'category'
    )
    expect(fk).toBeDefined()
    expect(fk!.referencedColumns).toEqual(['id'])
    expect(fk!.onDelete).toBe('SET NULL')

    expect(sql.constraintsUp).toContain(
      'FOREIGN KEY ("parent_id") REFERENCES "category" ("id") ON DELETE SET NULL'
    )
  })

  test('required self-FK emits ON DELETE RESTRICT', () => {
    const node = defineSchema('node', {
      fields: {
        id: t.bigserial().primaryKey(),
        ancestor: t.reference('node').required(),
      },
    })
    const { rep } = build([node])
    const table = rep.tables.find(t => t.name === 'node')!
    const fk = table.foreignKeys.find(f => f.referencedTable === 'node')!
    expect(fk.onDelete).toBe('RESTRICT')
  })

  test('tenanted self-FK is composite (tenant_id, parent_id) → self(tenant_id, id)', () => {
    const tenant = defineSchema('tenant', {
      tenantRegistry: true,
      fields: { id: t.uuid().primaryKey() },
    })
    const revision = defineSchema('revision', {
      archetype: Archetype.Component,
      tenanted: true,
      fields: {
        id: t.tenantedBigSerial().primaryKey(),
        parentRevision: t.reference('revision').nullable(),
      },
    })

    const { rep, sql } = build([tenant, revision])
    const table = rep.tables.find(t => t.name === 'revision')!

    const fk = table.foreignKeys.find(
      f => f.referencedTable === 'revision' && f.columns.length === 2
    )
    expect(fk).toBeDefined()
    expect(fk!.columns).toEqual(['tenant_id', 'parent_revision_id'])
    expect(fk!.referencedColumns).toEqual(['tenant_id', 'id'])
    // Composite FKs cannot SET NULL (tenant_id is NOT NULL); the framework
    // hard-codes CASCADE for any tenanted-composite FK regardless of the
    // field's required/nullable flag.
    expect(fk!.onDelete).toBe('CASCADE')

    expect(sql.constraintsUp).toContain(
      'FOREIGN KEY ("tenant_id", "parent_revision_id") REFERENCES "revision" ("tenant_id", "id")'
    )
  })
})

describe('Cross-table circular FKs via t.reference', () => {
  test('two non-tenanted schemas pointing at each other build without cycle error', () => {
    const workspace = defineSchema('workspace', {
      fields: {
        id: t.bigserial().primaryKey(),
        name: t.varchar(120).required(),
        owner: t.reference('user').required(),
      },
    })
    const user = defineSchema('user', {
      fields: {
        id: t.bigserial().primaryKey(),
        email: t.varchar(255).required(),
        lastWorkspace: t.reference('workspace').nullable(),
      },
    })

    // Registry resolve() must not throw on the cycle.
    const registry = new SchemaRegistry()
    registry.register(user)
    registry.register(workspace)
    expect(() => registry.resolve()).not.toThrow()

    // Both FKs must show up at the constraint level.
    const { rep, sql } = build([user, workspace])
    const wsTable = rep.tables.find(t => t.name === 'workspace')!
    const userTable = rep.tables.find(t => t.name === 'user')!

    expect(
      wsTable.foreignKeys.some(
        f => f.columns[0] === 'owner_id' && f.referencedTable === 'user'
      )
    ).toBe(true)
    expect(
      userTable.foreignKeys.some(
        f => f.columns[0] === 'last_workspace_id' && f.referencedTable === 'workspace'
      )
    ).toBe(true)

    // Both ALTER TABLE statements end up in constraints/up.sql, after both
    // CREATE TABLEs — so the migration is valid SQL regardless of order.
    expect(sql.constraintsUp).toContain('REFERENCES "user"')
    expect(sql.constraintsUp).toContain('REFERENCES "workspace"')
  })

  test('the cycle that previously triggered the topo error no longer throws', () => {
    // Mirrors the user-reported chain: membership → user → workspace → user.
    const workspace = defineSchema('workspace', {
      fields: {
        id: t.bigserial().primaryKey(),
        owner: t.reference('user').required(),
      },
    })
    const user = defineSchema('user', {
      fields: {
        id: t.bigserial().primaryKey(),
        lastWorkspace: t.reference('workspace').nullable(),
      },
    })
    const membership = defineSchema('membership', {
      archetype: Archetype.Component,
      parents: ['user'],
      fields: {
        role: t.varchar(50).required(),
      },
    })

    const registry = new SchemaRegistry()
    registry.register(user)
    registry.register(workspace)
    registry.register(membership)
    expect(() => registry.validate()).not.toThrow()
    expect(() => registry.resolve()).not.toThrow()
  })

  test('tenanted circular FK (doc ↔ revision) builds composite FKs both directions', () => {
    const tenant = defineSchema('tenant', {
      tenantRegistry: true,
      fields: { id: t.uuid().primaryKey() },
    })
    const doc = defineSchema('doc', {
      archetype: Archetype.Entity,
      tenanted: true,
      fields: {
        id: t.tenantedBigSerial().primaryKey(),
        currentRevision: t.reference('revision').nullable(),
      },
    })
    const revision = defineSchema('revision', {
      archetype: Archetype.Component,
      parents: ['doc'],
      tenanted: true,
      fields: {
        id: t.tenantedBigSerial().primaryKey(),
        bodyHash: t.varchar(64).required(),
      },
    })

    const { rep, sql } = build([tenant, doc, revision])
    const docTable = rep.tables.find(t => t.name === 'doc')!
    const revTable = rep.tables.find(t => t.name === 'revision')!

    expect(
      docTable.foreignKeys.some(
        f =>
          f.columns.join(',') === 'tenant_id,current_revision_id' &&
          f.referencedTable === 'revision'
      )
    ).toBe(true)
    expect(
      revTable.foreignKeys.some(
        f =>
          f.columns.join(',') === 'tenant_id,doc_id' && f.referencedTable === 'doc'
      )
    ).toBe(true)

    expect(sql.constraintsUp).toContain('REFERENCES "revision" ("tenant_id", "id")')
    expect(sql.constraintsUp).toContain('REFERENCES "doc" ("tenant_id", "id")')
  })

  test('SchemaDiff counts the circular FKs in constraint changes', () => {
    const a = defineSchema('a', {
      fields: {
        id: t.bigserial().primaryKey(),
        b: t.reference('b').nullable(),
      },
    })
    const b = defineSchema('b', {
      fields: {
        id: t.bigserial().primaryKey(),
        a: t.reference('a').nullable(),
      },
    })
    const { diff } = build([a, b])
    const fkAdds = diff.constraints.filter(c => c.kind === 'add_fk')
    const aFk = fkAdds.find(c => c.tableName === 'a' && c.constraint.referencedTable === 'b')
    const bFk = fkAdds.find(c => c.tableName === 'b' && c.constraint.referencedTable === 'a')
    expect(aFk).toBeDefined()
    expect(bFk).toBeDefined()
  })
})
