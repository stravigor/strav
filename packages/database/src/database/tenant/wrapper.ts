import type { SQL } from 'bun'
import { getCurrentTenantId, hasTenantContext } from './context'

/**
 * Wrap a Bun {@link SQL} client so every query runs inside a transaction
 * with `app.tenant_id` set via `set_config(..., true)` (transaction-local).
 *
 * RLS policies on tenanted tables read this setting, so isolation is
 * enforced by PostgreSQL itself — the application code does not inject
 * any WHERE clauses.
 *
 * No-op when there is no tenant context (passes through to the underlying
 * client unchanged).
 */
export function createTenantAwareSQL(sql: SQL): SQL {
  return new Proxy(sql, {
    apply(target, thisArg, argArray) {
      if (!hasTenantContext()) {
        return Reflect.apply(target as any, thisArg, argArray)
      }
      const tenantId = getCurrentTenantId()!
      return target.begin(async (tx: any) => {
        await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`
        return await (tx as any)(...argArray)
      })
    },

    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver)

      if (prop === 'unsafe') {
        return async function (sqlText: string, params?: any[]) {
          if (!hasTenantContext()) return target.unsafe(sqlText, params)
          const tenantId = getCurrentTenantId()!
          return target.begin(async (tx: any) => {
            await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`
            return await tx.unsafe(sqlText, params)
          })
        }
      }

      if (prop === 'begin' || prop === 'transaction') {
        return async function (callback: (tx: SQL) => any) {
          if (!hasTenantContext()) return (value as Function).call(target, callback)
          const tenantId = getCurrentTenantId()!
          return target.begin(async (tx: any) => {
            await tx`SELECT set_config('app.tenant_id', ${tenantId}, true)`
            return callback(tx)
          })
        }
      }

      if (typeof value === 'function') {
        return value.bind(target)
      }

      return value
    },
  }) as SQL
}
