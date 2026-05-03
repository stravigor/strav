import { AsyncLocalStorage } from 'node:async_hooks'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface TenantContext {
  tenantId: string
  bypass?: boolean
}

export const tenantStorage = new AsyncLocalStorage<TenantContext>()

/**
 * Execute a function within a tenant context.
 *
 * All database operations against tenant-scoped tables will be filtered
 * by PostgreSQL row-level security to rows where `tenant_id` matches
 * the given UUID.
 *
 * @example
 * await withTenant('a3b1c4d5-...', async () => {
 *   const orders = await Order.all() // only this tenant's rows
 * })
 */
export async function withTenant<T>(
  tenantId: string,
  callback: () => T | Promise<T>
): Promise<T> {
  if (!UUID_RE.test(tenantId)) {
    throw new Error(`Invalid tenant id: ${tenantId}. Must be a UUID.`)
  }
  return tenantStorage.run({ tenantId }, callback)
}

/**
 * Execute a function with tenant isolation bypassed.
 *
 * Routes queries through a separate connection bound to a role with the
 * BYPASSRLS attribute. Use only for admin/migration paths.
 */
export async function withoutTenant<T>(callback: () => T | Promise<T>): Promise<T> {
  return tenantStorage.run({ tenantId: '', bypass: true }, callback)
}

export function getCurrentTenantContext(): TenantContext | null {
  return tenantStorage.getStore() ?? null
}

export function getCurrentTenantId(): string | null {
  const ctx = getCurrentTenantContext()
  if (!ctx || ctx.bypass) return null
  return ctx.tenantId
}

export function hasTenantContext(): boolean {
  const ctx = getCurrentTenantContext()
  return ctx !== null && !ctx.bypass && ctx.tenantId !== ''
}

export function isBypassingTenant(): boolean {
  const ctx = getCurrentTenantContext()
  return ctx !== null && ctx.bypass === true
}
