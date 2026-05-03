import { join } from 'node:path'
import type { GeneratorConfig, GeneratorPaths } from '../generators/config.ts'
import { resolvePaths } from '../generators/config.ts'

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
