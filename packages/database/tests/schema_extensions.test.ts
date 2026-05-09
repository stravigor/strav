import { expect, test, describe } from 'bun:test'
import defineSchema from '../src/schema/define_schema'
import { Archetype } from '../src/schema/types'
import t from '../src/schema/type_builder'
import RepresentationBuilder from '../src/schema/representation_builder'
import SqlGenerator from '../src/database/migration/sql_generator'
import SchemaDiffer from '../src/database/migration/differ'
import MigrationFileGenerator from '../src/database/migration/file_generator'
import type { DatabaseRepresentation } from '../src/schema/database_representation'
import type { SchemaDefinition } from '../src/schema/types'

const EMPTY_REP: DatabaseRepresentation = { extensions: [], enums: [], tables: [] }

function build(schemas: SchemaDefinition[], actual: DatabaseRepresentation = EMPTY_REP) {
  const rep = new RepresentationBuilder(schemas).build()
  const diff = new SchemaDiffer().diff(rep, actual)
  const sql = new SqlGenerator().generate(diff)
  return { rep, diff, sql }
}

describe('Extensions DSL → representation', () => {
  test('a single extensions:[…] declaration ends up in the representation', () => {
    const embedding = defineSchema('embedding', {
      archetype: Archetype.Component,
      parents: ['user'],
      extensions: ['vector'],
      fields: { contentHash: t.varchar(64).required() },
    })
    const user = defineSchema('user', { fields: { email: t.varchar(255).required() } })

    const { rep } = build([user, embedding])
    expect(rep.extensions).toEqual(['vector'])
  })

  test('extensions are deduped + sorted across schemas', () => {
    const a = defineSchema('a', {
      extensions: ['pg_trgm', 'vector'],
      fields: { name: t.varchar(64).required() },
    })
    const b = defineSchema('b', {
      extensions: ['vector', 'citext'],
      fields: { name: t.varchar(64).required() },
    })

    const { rep } = build([a, b])
    expect(rep.extensions).toEqual(['citext', 'pg_trgm', 'vector'])
  })

  test('schemas without extensions produce an empty extensions list', () => {
    const a = defineSchema('a', { fields: { name: t.varchar(64).required() } })
    const { rep } = build([a])
    expect(rep.extensions).toEqual([])
  })

  test('duplicate within a single schema is silently deduped', () => {
    const a = defineSchema('a', {
      extensions: ['vector', 'vector'],
      fields: { name: t.varchar(64).required() },
    })
    const { rep } = build([a])
    expect(rep.extensions).toEqual(['vector'])
  })

  test('non-string entry throws at defineSchema time', () => {
    expect(() =>
      defineSchema('bad', {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        extensions: ['vector', 42 as any],
        fields: { name: t.varchar(64).required() },
      })
    ).toThrow(/extensions entry must be a non-empty string/)
  })

  test('empty-string entry throws at defineSchema time', () => {
    expect(() =>
      defineSchema('bad', {
        extensions: [''],
        fields: { name: t.varchar(64).required() },
      })
    ).toThrow(/extensions entry must be a non-empty string/)
  })
})

describe('Extensions diff → SQL', () => {
  test('first declaration emits CREATE EXTENSION IF NOT EXISTS in extensionsUp', () => {
    const a = defineSchema('a', {
      extensions: ['vector'],
      fields: { name: t.varchar(64).required() },
    })

    const { diff, sql } = build([a])
    expect(diff.extensions).toEqual([{ kind: 'create', name: 'vector' }])
    expect(sql.extensionsUp).toBe('CREATE EXTENSION IF NOT EXISTS "vector";')
    expect(sql.extensionsDown).toBe('DROP EXTENSION IF EXISTS "vector";')
  })

  test('removing every declaration produces a DROP EXTENSION', () => {
    const desired: DatabaseRepresentation = { extensions: [], enums: [], tables: [] }
    const actual: DatabaseRepresentation = {
      extensions: ['pg_trgm'],
      enums: [],
      tables: [],
    }

    const diff = new SchemaDiffer().diff(desired, actual)
    expect(diff.extensions).toEqual([{ kind: 'drop', name: 'pg_trgm' }])

    const sql = new SqlGenerator().generate(diff)
    expect(sql.extensionsUp).toBe('DROP EXTENSION IF EXISTS "pg_trgm";')
    expect(sql.extensionsDown).toBe('CREATE EXTENSION IF NOT EXISTS "pg_trgm";')
  })

  test('extensions already installed produce no diff', () => {
    const a = defineSchema('a', {
      extensions: ['vector'],
      fields: { name: t.varchar(64).required() },
    })
    const rep = new RepresentationBuilder([a]).build()
    const actual: DatabaseRepresentation = {
      extensions: ['vector'],
      enums: [],
      tables: rep.tables,
    }

    const diff = new SchemaDiffer().diff(rep, actual)
    expect(diff.extensions).toEqual([])

    const sql = new SqlGenerator().generate(diff)
    expect(sql.extensionsUp).toBe('')
    expect(sql.extensionsDown).toBe('')
  })

  test('adding one new extension to an existing set emits only the new CREATE', () => {
    const a = defineSchema('a', {
      extensions: ['vector', 'pg_trgm'],
      fields: { name: t.varchar(64).required() },
    })
    const rep = new RepresentationBuilder([a]).build()
    const actual: DatabaseRepresentation = {
      extensions: ['vector'], // pg_trgm is the new one
      enums: [],
      tables: rep.tables,
    }

    const diff = new SchemaDiffer().diff(rep, actual)
    expect(diff.extensions).toEqual([{ kind: 'create', name: 'pg_trgm' }])

    const sql = new SqlGenerator().generate(diff)
    expect(sql.extensionsUp).toBe('CREATE EXTENSION IF NOT EXISTS "pg_trgm";')
  })

  test('hyphenated extension names are quoted (uuid-ossp)', () => {
    const a = defineSchema('a', {
      extensions: ['uuid-ossp'],
      fields: { name: t.varchar(64).required() },
    })
    const { sql } = build([a])
    expect(sql.extensionsUp).toBe('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";')
  })
})

describe('Extensions in MigrationFileGenerator', () => {
  test('extensions/up.sql leads upOrder; extensions/down.sql trails downOrder', async () => {
    const tmpRoot = `/tmp/strav-extensions-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const a = defineSchema('a', {
      extensions: ['vector'],
      fields: { name: t.varchar(64).required() },
    })

    const { diff, sql } = build([a])
    const fileGen = new MigrationFileGenerator(tmpRoot)
    const dir = await fileGen.generate('1700000000000', 'add-vector', sql, diff)

    const manifest = await Bun.file(`${dir}/manifest.json`).json()
    expect(manifest.executionOrder.up[0]).toBe('extensions/up.sql')
    expect(manifest.executionOrder.up).toContain('tables/a/up.sql')
    expect(manifest.executionOrder.down[manifest.executionOrder.down.length - 1]).toBe(
      'extensions/down.sql'
    )
    expect(manifest.summary.extensionsToCreate).toBe(1)
    expect(manifest.summary.extensionsToDrop).toBe(0)

    const upContent = await Bun.file(`${dir}/extensions/up.sql`).text()
    expect(upContent).toContain('CREATE EXTENSION IF NOT EXISTS "vector";')
  })

  test('no extensions → no extensions/ directory referenced in manifest', async () => {
    const tmpRoot = `/tmp/strav-extensions-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const a = defineSchema('a', { fields: { name: t.varchar(64).required() } })

    const { diff, sql } = build([a])
    const fileGen = new MigrationFileGenerator(tmpRoot)
    const dir = await fileGen.generate('1700000000001', 'no-extensions', sql, diff)

    const manifest = await Bun.file(`${dir}/manifest.json`).json()
    expect(manifest.executionOrder.up).not.toContain('extensions/up.sql')
    expect(manifest.executionOrder.down).not.toContain('extensions/down.sql')
    expect(manifest.summary.extensionsToCreate).toBe(0)
  })
})
