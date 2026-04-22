import { join, isAbsolute, resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { EmbeddedConfig } from '../types.ts'

const MEMORY = ':memory:'

/**
 * Resolve the on-disk path for a given index, creating the parent directory
 * if necessary. Returns ':memory:' verbatim when the config asks for it.
 */
export function resolveIndexPath(config: EmbeddedConfig, index: string): string {
  const root = config.path ?? './storage/search'

  if (root === MEMORY) return MEMORY

  const dir = isAbsolute(root) ? root : resolve(process.cwd(), root)
  mkdirSync(dir, { recursive: true })

  const safeName = index.replace(/[^a-zA-Z0-9_.-]/g, '_')
  return join(dir, `${safeName}.sqlite`)
}

export const MEMORY_PATH = MEMORY
