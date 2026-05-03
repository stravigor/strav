import type { SQL } from 'bun'
import Database from './database'

export { default as Database } from './database'
export { Seeder } from './seeder'
export { default as DatabaseIntrospector } from './introspector'
export { default as QueryBuilder, query, transaction } from './query_builder'
export type { PaginationResult, PaginationMeta } from './query_builder'
export * from './migration/index'
export * from './tenant/index'

/**
 * Pre-configured SQL tagged-template client.
 *
 * A transparent proxy to the Database singleton's underlying Bun SQL connection.
 * Available after the Database is resolved through the DI container.
 *
 * @example
 * import { sql } from '@strav/database/database'
 * const rows = await sql`SELECT * FROM "user" WHERE "id" = ${id}`
 * await sql.begin(async (tx) => { ... })
 */
export const sql: SQL = new Proxy((() => {}) as unknown as SQL, {
  apply(_target, _thisArg, args) {
    return (Database.raw as any)(...args)
  },
  get(_target, prop) {
    const real = Database.raw
    const val = (real as any)[prop]
    return typeof val === 'function' ? val.bind(real) : val
  },
})
