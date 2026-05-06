import { SQL } from 'bun'
import Configuration from '@strav/kernel/config/configuration'
import { inject } from '@strav/kernel/core/inject'
import { ConfigurationError } from '@strav/kernel/exceptions/errors'
import { env } from '@strav/kernel/helpers/env'
import { createTenantAwareSQL } from './tenant/wrapper'
import { hasTenantContext, isBypassingTenant } from './tenant/context'
import { type TenantIdType, getTenantIdType } from './tenant/id_type'
import { getTenantTableName, tenantFkColumnFor } from './tenant/naming'

/**
 * Database connection wrapper backed by {@link SQL Bun.sql}.
 *
 * Reads connection credentials from the `database.*` configuration keys
 * (loaded from `config/database.ts` / `.env`). Falls back to `DB_*`
 * environment variables when no config file is present.
 *
 * When `database.tenant.enabled` is true, the wrapper exposes two pools:
 *
 * - The **app** pool, used for normal request-time queries. Connects as
 *   a non-superuser role so PostgreSQL row-level security policies are
 *   enforced. Queries inside a `withTenant(...)` block are wrapped in a
 *   transaction that sets `app.tenant_id` via `set_config(..., true)`.
 * - The **bypass** pool, used by migrations, the `TenantManager`, and
 *   `withoutTenant(...)`. Connects as a role with the BYPASSRLS attribute
 *   so RLS policies do not apply.
 *
 * Register as a singleton in the DI container so a single connection pool
 * pair is shared across the application.
 */
@inject
export default class Database {
  private static _appConnection: SQL | null = null
  private static _bypassConnection: SQL | null = null
  private static _tenantEnabled: boolean = false

  private appConnection: SQL
  private _bypassConnection: SQL | null = null
  private tenantEnabled: boolean
  private tenantAwareConnection: SQL

  constructor(protected config: Configuration) {
    if (Database._appConnection) {
      Database._appConnection.close()
    }
    if (Database._bypassConnection) {
      Database._bypassConnection.close()
      Database._bypassConnection = null
    }

    this.appConnection = new SQL({
      hostname: config.get('database.host') ?? env('DB_HOST', '127.0.0.1'),
      port: config.get('database.port') ?? env.int('DB_PORT', 5432),
      username: config.get('database.username') ?? env('DB_USER', 'postgres'),
      password: config.get('database.password') ?? env('DB_PASSWORD', ''),
      database: config.get('database.database') ?? env('DB_DATABASE', 'strav'),
      max: config.get('database.pool') ?? env.int('DB_POOL_MAX', 10),
      idleTimeout: config.get('database.idleTimeout') ?? env.int('DB_IDLE_TIMEOUT', 20),
    })
    Database._appConnection = this.appConnection

    this.tenantEnabled = config.get('database.tenant.enabled') ?? false
    Database._tenantEnabled = this.tenantEnabled

    if (config.get('database.tenant.idType') !== undefined) {
      throw new ConfigurationError(
        'database.tenant.idType is no longer supported. Define a tenant table via defineSchema(...) with `tenantRegistry: true`; the framework derives the id type from its primary key. See docs/database/multitenant.md.'
      )
    }
    if (config.get('database.tenant.tableName') !== undefined) {
      throw new ConfigurationError(
        'database.tenant.tableName is no longer supported. Define a tenant table via defineSchema(...) with `tenantRegistry: true`; the schema name becomes the table name. See docs/database/multitenant.md.'
      )
    }

    this.tenantAwareConnection = this.tenantEnabled
      ? createTenantAwareSQL(this.appConnection)
      : this.appConnection
  }

  /**
   * Tenant id cast type. Sourced from the tenant registry schema's PK
   * (`SchemaRegistry.register` populates the module-level state). Defaults
   * to `'bigint'` until a tenant schema is registered.
   */
  get tenantIdType(): TenantIdType {
    return getTenantIdType()
  }

  /** Tenant table name from the registered tenant schema. Defaults to `'tenant'`. */
  get tenantTableName(): string {
    return getTenantTableName()
  }

  /** FK column name on tenanted children: `${tenantTableName}_id`. */
  get tenantFkColumn(): string {
    return tenantFkColumnFor(this.tenantTableName)
  }

  /**
   * The SQL client routed for the current async context.
   *
   * - In a `withoutTenant(...)` block: returns the bypass connection.
   * - In a `withTenant(...)` block: returns a tenant-aware proxy that
   *   wraps each query in a transaction with `set_config('app.tenant_id', ...)`.
   * - Otherwise: returns the raw app connection.
   */
  get sql(): SQL {
    if (this.tenantEnabled && isBypassingTenant()) {
      return this.bypass
    }
    if (this.tenantEnabled && hasTenantContext()) {
      return this.tenantAwareConnection
    }
    return this.appConnection
  }

  /**
   * The bypass connection (BYPASSRLS role). Lazily created on first use.
   * Throws if `database.tenant.bypass.username` is not configured.
   */
  get bypass(): SQL {
    if (!this.tenantEnabled) {
      return this.appConnection
    }

    if (this._bypassConnection) return this._bypassConnection

    const bypassUser = this.config.get('database.tenant.bypass.username') ?? env('DB_BYPASS_USER')
    const bypassPassword =
      this.config.get('database.tenant.bypass.password') ?? env('DB_BYPASS_PASSWORD', '')

    if (!bypassUser) {
      throw new ConfigurationError(
        'Bypass connection requested but database.tenant.bypass.username is not set. ' +
          'Configure a PostgreSQL role with the BYPASSRLS attribute.'
      )
    }

    this._bypassConnection = new SQL({
      hostname: this.config.get('database.host') ?? env('DB_HOST', '127.0.0.1'),
      port: this.config.get('database.port') ?? env.int('DB_PORT', 5432),
      username: bypassUser,
      password: bypassPassword,
      database: this.config.get('database.database') ?? env('DB_DATABASE', 'strav'),
      max: this.config.get('database.tenant.bypass.pool') ?? env.int('DB_BYPASS_POOL_MAX', 4),
      idleTimeout:
        this.config.get('database.idleTimeout') ?? env.int('DB_IDLE_TIMEOUT', 20),
    })
    Database._bypassConnection = this._bypassConnection

    return this._bypassConnection
  }

  /** The global SQL connection, available after DI bootstrap. */
  static get raw(): SQL {
    if (!Database._appConnection) {
      throw new ConfigurationError(
        'Database not configured. Resolve Database through the container first.'
      )
    }

    if (Database._tenantEnabled && isBypassingTenant()) {
      if (!Database._bypassConnection) {
        throw new ConfigurationError(
          'Bypass connection requested but not initialised. ' +
            'Resolve Database via the DI container before calling withoutTenant().'
        )
      }
      return Database._bypassConnection
    }

    if (Database._tenantEnabled && hasTenantContext()) {
      return createTenantAwareSQL(Database._appConnection)
    }

    return Database._appConnection
  }

  /** Close all connection pools. */
  async close(): Promise<void> {
    await this.appConnection.close()
    if (Database._appConnection === this.appConnection) {
      Database._appConnection = null
    }
    if (this._bypassConnection) {
      await this._bypassConnection.close()
      this._bypassConnection = null
      if (Database._bypassConnection === null) {
        // already cleared
      } else {
        Database._bypassConnection = null
      }
    }
  }

  /** Whether multi-tenant (RLS) mode is enabled. */
  get isMultiTenant(): boolean {
    return this.tenantEnabled
  }
}
