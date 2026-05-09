import { expect, test, describe } from 'bun:test'
import defineSchema from '../src/schema/define_schema'
import { Archetype } from '../src/schema/types'
import t from '../src/schema/type_builder'
import RepresentationBuilder from '../src/schema/representation_builder'
import SqlGenerator from '../src/database/migration/sql_generator'
import SchemaDiffer from '../src/database/migration/differ'
import type { TableDefinition } from '../src/schema/database_representation'
import type { SchemaDefinition } from '../src/schema/types'

function build(schemas: SchemaDefinition[]) {
  const rep = new RepresentationBuilder(schemas).build()
  const diff = new SchemaDiffer().diff(rep, { enums: [], tables: [] })
  const sql = new SqlGenerator().generate(diff)
  return { rep, sql }
}

function tableOf(rep: { tables: TableDefinition[] }, name: string): TableDefinition {
  const t = rep.tables.find(x => x.name === name)
  if (!t) throw new Error(`expected table "${name}" in representation`)
  return t
}

const user = defineSchema('user', {
  fields: { email: t.varchar(255).required() },
})

describe('Schema DSL — parent FK uniqueness', () => {
  test('parents:[{ name, unique: true }] emits a unique index on the FK column', () => {
    const totp = defineSchema('totp_secret', {
      archetype: Archetype.Component,
      parents: [{ name: 'user', unique: true }],
      fields: {
        secretEncrypted: t.bytea().required().sensitive(),
      },
    })

    const { rep, sql } = build([user, totp])
    const table = tableOf(rep, 'totp_secret')

    const idx = table.indexes.find(i => i.columns.length === 1 && i.columns[0] === 'user_id')
    expect(idx).toBeDefined()
    expect(idx!.unique).toBe(true)

    expect(table.uniqueConstraints.some(uq => uq.columns.join(',') === 'user_id')).toBe(false)

    expect(sql.indexesUp).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "idx_totp_secret_user_id_unique"'
    )
  })

  test('plain string parent stays non-unique (backwards compatible)', () => {
    const profile = defineSchema('profile', {
      archetype: Archetype.Component,
      parents: ['user'],
      fields: { bio: t.text().required() },
    })

    const { rep } = build([user, profile])
    const table = tableOf(rep, 'profile')
    const idx = table.indexes.find(i => i.columns[0] === 'user_id' && i.columns.length === 1)
    expect(idx).toBeDefined()
    expect(idx!.unique).toBe(false)
  })

  test('duplicate parent name throws at defineSchema time', () => {
    expect(() =>
      defineSchema('bad', {
        archetype: Archetype.Component,
        parents: ['user', { name: 'user', unique: true }],
        fields: { x: t.text().required() },
      })
    ).toThrow(/lists parent "user" more than once/)
  })
})

describe('Schema DSL — schema-level `uniques`', () => {
  test('composite uniques produces UNIQUE constraint and matching unique index', () => {
    const oauth = defineSchema('oauth_identity', {
      archetype: Archetype.Component,
      parents: ['user'],
      fields: {
        provider: t.enum(['google', 'github']).required(),
        providerUserId: t.varchar(255).required(),
      },
      uniques: [['provider', 'providerUserId']],
    })

    const { rep, sql } = build([user, oauth])
    const table = tableOf(rep, 'oauth_identity')

    expect(
      table.uniqueConstraints.some(
        uq => uq.columns.join(',') === 'provider,provider_user_id'
      )
    ).toBe(true)
    expect(
      table.indexes.some(
        i => i.unique && i.columns.join(',') === 'provider,provider_user_id'
      )
    ).toBe(true)

    expect(sql.constraintsUp).toContain(
      'ADD CONSTRAINT "uq_oauth_identity_provider_provider_user_id" UNIQUE ("provider", "provider_user_id")'
    )
  })

  test('uniques entry of parent name expands to its FK column', () => {
    const recovery = defineSchema('recovery_code', {
      archetype: Archetype.Component,
      parents: ['user'],
      fields: { codeHash: t.varchar(255).required() },
      uniques: [['user', 'codeHash']],
    })

    const { rep, sql } = build([user, recovery])
    const table = tableOf(rep, 'recovery_code')

    expect(
      table.uniqueConstraints.some(
        uq => uq.columns.join(',') === 'user_id,code_hash'
      )
    ).toBe(true)
    expect(sql.constraintsUp).toContain(
      'ADD CONSTRAINT "uq_recovery_code_user_id_code_hash" UNIQUE ("user_id", "code_hash")'
    )
  })

  test('single-column uniques entry emits a unique index, not a UNIQUE constraint', () => {
    const totp = defineSchema('totp_secret', {
      archetype: Archetype.Component,
      parents: ['user'],
      fields: { secretEncrypted: t.bytea().required() },
      uniques: [['user']],
    })

    const { rep } = build([user, totp])
    const table = tableOf(rep, 'totp_secret')

    expect(
      table.uniqueConstraints.some(uq => uq.columns.join(',') === 'user_id')
    ).toBe(false)
    expect(
      table.indexes.some(i => i.unique && i.columns.join(',') === 'user_id')
    ).toBe(true)
  })

  test('unknown column in uniques throws with a helpful message', () => {
    const bad = defineSchema('bad', {
      archetype: Archetype.Component,
      parents: ['user'],
      fields: { name: t.varchar(255).required() },
      uniques: [['user', 'doesNotExist']],
    })

    expect(() => build([user, bad])).toThrow(
      /uniques references unknown column "doesNotExist"/
    )
  })

  test('empty uniques entry throws at defineSchema time', () => {
    expect(() =>
      defineSchema('bad', {
        archetype: Archetype.Component,
        parents: ['user'],
        fields: { name: t.varchar(255).required() },
        uniques: [[]],
      })
    ).toThrow(/non-empty array of column names/)
  })

  test('duplicate column inside a uniques entry throws at defineSchema time', () => {
    expect(() =>
      defineSchema('bad', {
        archetype: Archetype.Component,
        parents: ['user'],
        fields: { name: t.varchar(255).required() },
        uniques: [['name', 'name']],
      })
    ).toThrow(/names "name" more than once/)
  })

  test('duplicate uniques entries are deduped in the representation', () => {
    const dup = defineSchema('dup', {
      archetype: Archetype.Component,
      parents: ['user'],
      fields: {
        a: t.varchar(255).required(),
        b: t.varchar(255).required(),
      },
      uniques: [
        ['a', 'b'],
        ['b', 'a'], // same set, different order — should fold
      ],
    })

    const { rep } = build([user, dup])
    const table = tableOf(rep, 'dup')
    const matching = table.uniqueConstraints.filter(uq =>
      [...uq.columns].sort().join(',') === 'a,b'
    )
    expect(matching).toHaveLength(1)
  })

  test('tenant_id can be referenced explicitly to scope uniqueness by tenant', () => {
    const tenant = defineSchema('tenant', {
      tenantRegistry: true,
      fields: { id: t.uuid().primaryKey() },
    })

    const note = defineSchema('note', {
      archetype: Archetype.Component,
      parents: ['user'],
      tenanted: true,
      fields: { slug: t.varchar(255).required() },
      uniques: [['tenant_id', 'slug']],
    })

    const { rep } = build([tenant, user, note])
    const table = tableOf(rep, 'note')
    expect(
      table.uniqueConstraints.some(
        uq => uq.columns.join(',') === 'tenant_id,slug'
      )
    ).toBe(true)
  })
})
