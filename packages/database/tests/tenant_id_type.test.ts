import { expect, test, describe } from 'bun:test'
import {
  type TenantIdType,
  DEFAULT_TENANT_ID_TYPE,
  setTenantIdType,
  getTenantIdType,
  validateTenantId,
} from '../src/database/tenant/id_type'
import { tenantTableSQL } from '../src/database/tenant/seed'
import {
  tenantIdColumnDDL,
  createTenantPolicyStatement,
} from '../src/database/tenant/policies'
import RepresentationBuilder from '../src/schema/representation_builder'
import { Archetype, type SchemaDefinition } from '../src/schema/types'

// ---------------------------------------------------------------------------
// validateTenantId
// ---------------------------------------------------------------------------

describe('validateTenantId', () => {
  test('uuid: accepts a canonical UUID', () => {
    expect(() =>
      validateTenantId('uuid', '550e8400-e29b-41d4-a716-446655440000')
    ).not.toThrow()
  })

  test('uuid: accepts upper-case hex', () => {
    expect(() =>
      validateTenantId('uuid', '550E8400-E29B-41D4-A716-446655440000')
    ).not.toThrow()
  })

  test('uuid: rejects integers', () => {
    expect(() => validateTenantId('uuid', '1234')).toThrow(/Must be a UUID/)
  })

  test('uuid: rejects empty / garbage', () => {
    expect(() => validateTenantId('uuid', '')).toThrow(/Must be a UUID/)
    expect(() => validateTenantId('uuid', 'not-a-uuid')).toThrow(/Must be a UUID/)
  })

  test('bigint: accepts positive and negative integers', () => {
    expect(() => validateTenantId('bigint', '0')).not.toThrow()
    expect(() => validateTenantId('bigint', '1')).not.toThrow()
    expect(() => validateTenantId('bigint', '999999999999999')).not.toThrow()
    expect(() => validateTenantId('bigint', '-42')).not.toThrow()
  })

  test('bigint: rejects UUIDs', () => {
    expect(() =>
      validateTenantId('bigint', '550e8400-e29b-41d4-a716-446655440000')
    ).toThrow(/Must be an integer/)
  })

  test('bigint: rejects floats and scientific notation', () => {
    expect(() => validateTenantId('bigint', '1.5')).toThrow(/Must be an integer/)
    expect(() => validateTenantId('bigint', '1e10')).toThrow(/Must be an integer/)
  })

  test('bigint: rejects empty and non-numeric', () => {
    expect(() => validateTenantId('bigint', '')).toThrow(/Must be an integer/)
    expect(() => validateTenantId('bigint', 'abc')).toThrow(/Must be an integer/)
  })
})

// ---------------------------------------------------------------------------
// Module-level get/set
// ---------------------------------------------------------------------------

describe('getTenantIdType / setTenantIdType', () => {
  test('default is bigint', () => {
    // Reset to default for isolation; tenant.test.ts may have set 'uuid'.
    setTenantIdType(DEFAULT_TENANT_ID_TYPE)
    expect(getTenantIdType()).toBe('bigint')
  })

  test('round-trips through setter', () => {
    setTenantIdType('uuid')
    expect(getTenantIdType()).toBe('uuid')
    setTenantIdType('bigint')
    expect(getTenantIdType()).toBe('bigint')
  })
})

// ---------------------------------------------------------------------------
// Tenant table DDL
// ---------------------------------------------------------------------------

describe('tenantTableSQL', () => {
  test("uuid: emits UUID PK with gen_random_uuid()", () => {
    const sql = tenantTableSQL('uuid')
    expect(sql).toContain(`"id" UUID NOT NULL DEFAULT gen_random_uuid()`)
    expect(sql).not.toContain('BIGSERIAL')
  })

  test("bigint: emits BIGSERIAL PK", () => {
    const sql = tenantTableSQL('bigint')
    expect(sql).toContain(`"id" BIGSERIAL NOT NULL`)
    expect(sql).not.toContain('UUID')
    expect(sql).not.toContain('gen_random_uuid')
  })
})

// ---------------------------------------------------------------------------
// RLS policy + tenant_id column DDL
// ---------------------------------------------------------------------------

describe('createTenantPolicyStatement', () => {
  test('uuid casts to ::uuid in USING and WITH CHECK', () => {
    const sql = createTenantPolicyStatement('orders', 'uuid')
    expect(sql).toMatch(/USING \("tenant_id" = current_setting\([^)]+\)::uuid\)/)
    expect(sql).toMatch(/WITH CHECK \("tenant_id" = current_setting\([^)]+\)::uuid\)/)
  })

  test('bigint casts to ::bigint', () => {
    const sql = createTenantPolicyStatement('orders', 'bigint')
    expect(sql).toMatch(/USING \("tenant_id" = current_setting\([^)]+\)::bigint\)/)
    expect(sql).toMatch(/WITH CHECK \("tenant_id" = current_setting\([^)]+\)::bigint\)/)
  })
})

describe('tenantIdColumnDDL', () => {
  test("uuid: column is UUID with ::uuid cast in DEFAULT", () => {
    const ddl = tenantIdColumnDDL('uuid')
    expect(ddl).toContain('"tenant_id" UUID NOT NULL')
    expect(ddl).toContain(`current_setting('app.tenant_id', true)::uuid`)
    expect(ddl).toContain(`REFERENCES "tenant" ("id")`)
  })

  test("bigint: column is BIGINT with ::bigint cast in DEFAULT", () => {
    const ddl = tenantIdColumnDDL('bigint')
    expect(ddl).toContain('"tenant_id" BIGINT NOT NULL')
    expect(ddl).toContain(`current_setting('app.tenant_id', true)::bigint`)
    expect(ddl).toContain(`REFERENCES "tenant" ("id")`)
  })
})

// ---------------------------------------------------------------------------
// RepresentationBuilder integration — tenant_id column shape
// ---------------------------------------------------------------------------

describe('RepresentationBuilder tenant_id injection', () => {
  function buildOrdersWithIdType(idType: TenantIdType) {
    const orders: SchemaDefinition = {
      name: 'orders',
      archetype: Archetype.Entity,
      tenanted: true,
      fields: {
        // No explicit PK; builder adds default UUID PK.
        total: { type: 'integer', primaryKey: false } as any,
      } as any,
    } as any
    const rep = new RepresentationBuilder([orders], idType).build()
    const table = rep.tables.find(t => t.name === 'orders')!
    return table.columns.find(c => c.name === 'tenant_id')!
  }

  test("uuid: column pgType='uuid' and default casts to ::uuid", () => {
    const col = buildOrdersWithIdType('uuid')
    expect(col.pgType).toBe('uuid')
    expect(col.defaultValue).toEqual({
      kind: 'expression',
      sql: `current_setting('app.tenant_id', true)::uuid`,
    })
    expect(col.notNull).toBe(true)
  })

  test("bigint: column pgType='bigint' and default casts to ::bigint", () => {
    const col = buildOrdersWithIdType('bigint')
    expect(col.pgType).toBe('bigint')
    expect(col.defaultValue).toEqual({
      kind: 'expression',
      sql: `current_setting('app.tenant_id', true)::bigint`,
    })
    expect(col.notNull).toBe(true)
  })
})
