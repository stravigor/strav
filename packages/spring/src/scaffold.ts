import { readdirSync, mkdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import pkg from '../package.json'

export interface ScaffoldOptions {
  projectName: string
  template: 'api' | 'web'
  dbName: string
}

export async function scaffold(root: string, opts: ScaffoldOptions): Promise<void> {
  const templatesDir = join(import.meta.dir, 'templates')
  const appKey = crypto.randomUUID()

  const replacements: Record<string, string> = {
    __PROJECT_NAME__: opts.projectName,
    __DB_NAME__: opts.dbName,
    __APP_KEY__: appKey,
    __STRAV_VERSION__: `^${pkg.version}`,
  }

  // Copy shared files first, then template-specific (may override shared)
  await copyDir(join(templatesDir, 'shared'), root, replacements)
  await copyDir(join(templatesDir, opts.template), root, replacements)
}

async function copyDir(
  srcDir: string,
  destDir: string,
  replacements: Record<string, string>
): Promise<void> {
  const entries = readdirSync(srcDir)

  for (const entry of entries) {
    const srcPath = join(srcDir, entry)
    const destPath = join(destDir, entry.replace(/\.tpl$/, ''))

    if (statSync(srcPath).isDirectory()) {
      await copyDir(srcPath, destPath, replacements)
    } else {
      mkdirSync(dirname(destPath), { recursive: true })
      const content = await Bun.file(srcPath).text()
      await Bun.write(destPath, applyReplacements(content, replacements))
    }
  }
}

function applyReplacements(content: string, replacements: Record<string, string>): string {
  let result = content
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.replaceAll(placeholder, value)
  }
  return result
}