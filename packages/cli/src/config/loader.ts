import { join } from 'node:path'
import type { GeneratorConfig, GeneratorPaths } from '../generators/config.ts'
import { resolvePaths } from '../generators/config.ts'
import {
  type TenantIdType,
  DEFAULT_TENANT_ID_TYPE,
} from '@strav/database/database/tenant/id_type'

/**
 * Load the generator configuration from the project's config/generators.ts file.
 * Falls back to defaults if the file doesn't exist.
 */
export async function loadGeneratorConfig(): Promise<GeneratorConfig | undefined> {
  try {
    return (await import(join(process.cwd(), 'config/generators.ts'))).default
  } catch {
    return undefined
  }
}

/**
 * Get the fully resolved database paths from the configuration.
 */
export async function getDatabasePaths(): Promise<{ schemas: string; migrations: string }> {
  const config = await loadGeneratorConfig()
  const paths = resolvePaths(config)
  return { schemas: paths.schemas, migrations: paths.migrations }
}

/**
 * Get all resolved paths from the configuration.
 */
export async function getAllPaths(): Promise<GeneratorPaths> {
  const config = await loadGeneratorConfig()
  return resolvePaths(config)
}

/**
 * Read `database.tenant.idType` from `config/database.ts` for code-only
 * generators (generate:models, generate:api) that don't connect to the DB.
 * Falls back to the framework default if the config file or key is absent.
 */
export async function loadTenantIdType(): Promise<TenantIdType> {
  try {
    const dbConfig = (await import(join(process.cwd(), 'config/database.ts'))).default
    return (dbConfig?.tenant?.idType as TenantIdType | undefined) ?? DEFAULT_TENANT_ID_TYPE
  } catch {
    return DEFAULT_TENANT_ID_TYPE
  }
}
