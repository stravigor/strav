import { expect, test, describe } from 'bun:test'
import defineSchema from '../src/schema/define_schema'
import t from '../src/schema/type_builder'
import RepresentationBuilder from '../src/schema/representation_builder'
import SqlGenerator from '../src/database/migration/sql_generator'
import SchemaDiffer, { isFrameworkManagedTable } from '../src/database/migration/differ'
import MigrationFileGenerator from '../src/database/migration/file_generator'
import type {
  DatabaseRepresentation,
  TableDefinition,
} from '../src/schema/database_representation'

/**
 * Build an `actual` representation that simulates a live database which has
 * been booted by a provider (so `_strav_*` framework tables exist) but no
 * project migration has run yet.
 */
function actualWithFrameworkTables(): DatabaseRepresentation {
  const sessions: TableDefinition = {
    name: '_strav_sessions',
    columns: [
      {
        name: 'id',
        pgType: 'uuid',
        notNull: true,
        unique: true,
        primaryKey: true,
        autoIncrement: false,
        index: false,
        isArray: false,
        arrayDimensions: 1,
      },
    ],
    primaryKey: { columns: ['id'] },
    foreignKeys: [],
    uniqueConstraints: [],
    indexes: [],
  }
  const tokens: TableDefinition = {
    name: '_strav_access_tokens',
    columns: [
      {
        name: 'token',
        pgType: 'text',
        notNull: true,
        unique: true,
        primaryKey: false,
        autoIncrement: false,
        index: true,
        isArray: false,
        arrayDimensions: 1,
      },
    ],
    primaryKey: null,
    foreignKeys: [],
    uniqueConstraints: [{ columns: ['token'] }],
    indexes: [{ columns: ['token'], unique: true }],
  }
  return { extensions: [], enums: [], tables: [sessions, tokens] }
}

describe('Migration diff — framework-managed tables', () => {
  test('isFrameworkManagedTable matches _strav_* and rejects everything else', () => {
    expect(isFrameworkManagedTable('_strav_sessions')).toBe(true)
    expect(isFrameworkManagedTable('_strav_access_tokens')).toBe(true)
    expect(isFrameworkManagedTable('_strav_migrations')).toBe(true)
    expect(isFrameworkManagedTable('strav_sessions')).toBe(false)
    expect(isFrameworkManagedTable('user')).toBe(false)
    expect(isFrameworkManagedTable('')).toBe(false)
  })

  test('orphan _strav_* tables in the live DB produce no drops', () => {
    const user = defineSchema('user', { fields: { email: t.varchar(255).required() } })
    const desired = new RepresentationBuilder([user]).build()
    const actual = actualWithFrameworkTables()

    const diff = new SchemaDiffer().diff(desired, actual)
    expect(diff.tables.find(td => td.kind === 'drop')).toBeUndefined()
  })

  test('no orphan _strav_* constraint or index drops are emitted', () => {
    const user = defineSchema('user', { fields: { email: t.varchar(255).required() } })
    const desired = new RepresentationBuilder([user]).build()
    const actual = actualWithFrameworkTables()

    const diff = new SchemaDiffer().diff(desired, actual)
    expect(
      diff.constraints.some(c => 'tableName' in c && c.tableName.startsWith('_strav_'))
    ).toBe(false)
    expect(
      diff.indexes.some(i => 'tableName' in i && i.tableName.startsWith('_strav_'))
    ).toBe(false)
  })

  test('the SQL output mentions no _strav_* table operations', () => {
    const user = defineSchema('user', { fields: { email: t.varchar(255).required() } })
    const desired = new RepresentationBuilder([user]).build()
    const actual = actualWithFrameworkTables()

    const diff = new SchemaDiffer().diff(desired, actual)
    const sql = new SqlGenerator().generate(diff)

    expect(sql.constraintsUp).not.toContain('_strav_')
    expect(sql.constraintsDown).not.toContain('_strav_')
    expect(sql.indexesUp).not.toContain('_strav_')
    expect(sql.indexesDown).not.toContain('_strav_')
    expect([...sql.tables.keys()].some(n => n.startsWith('_strav_'))).toBe(false)
  })

  test('manifest summary tablesToDrop excludes framework drops', async () => {
    const tmpRoot = `/tmp/strav-fw-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const user = defineSchema('user', { fields: { email: t.varchar(255).required() } })
    const desired = new RepresentationBuilder([user]).build()
    const actual = actualWithFrameworkTables()

    const diff = new SchemaDiffer().diff(desired, actual)
    const sql = new SqlGenerator().generate(diff)
    const dir = await new MigrationFileGenerator(tmpRoot).generate(
      '1700000002000',
      'no-fw-drops',
      sql,
      diff
    )
    const manifest = await Bun.file(`${dir}/manifest.json`).json()
    expect(manifest.summary.tablesToDrop).toBe(0)
  })

  test('explicit defineSchema for a _strav_* name is treated as a normal table', () => {
    // Hypothetical override: project owns _strav_custom_audit. The diff
    // should NOT fire the framework filter; instead the table should
    // diff/modify normally against an actual table with the same name.
    const custom = defineSchema('_strav_custom_audit', {
      fields: { event: t.text().required() },
    })
    const desired = new RepresentationBuilder([custom]).build()

    // No actual representation: the framework filter would have suppressed
    // a drop, but here desired is the source of truth and it should
    // produce a CREATE.
    const actual: DatabaseRepresentation = { extensions: [], enums: [], tables: [] }
    const diff = new SchemaDiffer().diff(desired, actual)

    const create = diff.tables.find(
      td => td.kind === 'create' && td.table.name === '_strav_custom_audit'
    )
    expect(create).toBeDefined()
  })

  test('_strav_* table that is now project-owned modifies normally', () => {
    const owned = defineSchema('_strav_custom', {
      fields: {
        label: t.varchar(255).required(),
      },
    })
    const desired = new RepresentationBuilder([owned]).build()

    // Actual has the same table but missing the new column — should
    // produce a MODIFY, not be silently filtered.
    const actual: DatabaseRepresentation = {
      extensions: [],
      enums: [],
      tables: [
        {
          name: '_strav_custom',
          columns: [
            {
              name: 'id',
              pgType: 'serial',
              notNull: true,
              unique: true,
              primaryKey: true,
              autoIncrement: true,
              index: false,
              isArray: false,
              arrayDimensions: 1,
            },
          ],
          primaryKey: { columns: ['id'] },
          foreignKeys: [],
          uniqueConstraints: [],
          indexes: [],
        },
      ],
    }
    const diff = new SchemaDiffer().diff(desired, actual)
    const modify = diff.tables.find(
      td => td.kind === 'modify' && td.tableName === '_strav_custom'
    )
    expect(modify).toBeDefined()
  })
})
