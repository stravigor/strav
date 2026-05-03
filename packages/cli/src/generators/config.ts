import { resolve, relative } from 'node:path'
import type { GeneratedFile } from './model_generator.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GeneratorPaths {
  models: string
  enums: string
  controllers: string
  services: string
  events: string
  validators: string
  policies: string
  resources: string
  routes: string
  tests: string
  docs: string
  // Database paths
  schemas: string
  migrations: string
}

export interface GeneratorConfig {
  paths?: Partial<GeneratorPaths>
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_PATHS: GeneratorPaths = {
  models: 'app/models',
  enums: 'app/enums',
  controllers: 'app/http/controllers',
  services: 'app/services',
  events: 'app/events',
  validators: 'app/validators',
  policies: 'app/policies',
  resources: 'app/resources',
  routes: 'start',
  tests: 'tests/api',
  docs: 'public/_docs',
  schemas: 'database/schemas',
  migrations: 'database/migrations',
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Merge user config with defaults, returning fully resolved paths. */
export function resolvePaths(config?: GeneratorConfig): GeneratorPaths {
  return config?.paths ? { ...DEFAULT_PATHS, ...config.paths } : { ...DEFAULT_PATHS }
}

/**
 * Compute a relative import path from a file inside `fromDir` to a file
 * inside `toDir`. Returns a path suitable for ES import statements
 * (e.g. `'../../services'`, `'../enums'`).
 */
export function relativeImport(fromDir: string, toDir: string): string {
  let rel = relative(fromDir, toDir)
  rel = rel.split('\\').join('/')
  return rel.startsWith('.') ? rel : './' + rel
}

/**
 * Format generated files with Prettier and write them to disk.
 * Falls back to writing unformatted content if Prettier is not installed.
 */
export async function formatAndWrite(files: GeneratedFile[]): Promise<void> {
  let prettier: typeof import('prettier') | null = null
  try {
    prettier = await import('prettier')
  } catch {
    // Prettier not installed — write unformatted
  }

  for (const file of files) {
    let content = file.content
    if (prettier) {
      const filePath = resolve(file.path)
      const options = await prettier.resolveConfig(filePath)
      content = await prettier.format(content, { ...options, filepath: filePath })
    }
    await Bun.write(file.path, content)
  }
}
