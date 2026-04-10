#!/usr/bin/env bun
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { select, input } from './prompts.ts'
import { scaffold, type ScaffoldOptions } from './scaffold.ts'
import pkg from '../package.json'

const VERSION = pkg.version

// ── Colors ──────────────────────────────────────────────────────────

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`

// ── Arg parsing ─────────────────────────────────────────────────────

interface ParsedArgs {
  projectName?: string
  template?: 'api' | 'web'
  db?: string
  help?: boolean
}

function parseArgs(): ParsedArgs {
  const args = process.argv.slice(2)
  const result: ParsedArgs = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--help' || arg === '-h') {
      result.help = true
    } else if (arg === '--api') {
      result.template = 'api'
    } else if (arg === '--web') {
      result.template = 'web'
    } else if (arg === '--template' || arg === '-t') {
      const val = args[++i]
      if (val === 'api' || val === 'web') {
        result.template = val
      } else {
        console.error(red(`  Invalid template: ${val}. Use "api" or "web".`))
        process.exit(1)
      }
    } else if (arg === '--db') {
      result.db = args[++i]
    } else if (arg && !arg.startsWith('-') && !result.projectName) {
      result.projectName = arg
    }
  }

  return result
}

function printUsage(): void {
  console.log(`
  ${bold('@strav/spring')} ${dim(`v${VERSION}`)}
  ${dim('The Laravel of the Bun ecosystem')}

  ${bold('Usage:')}
    bunx @strav/spring ${cyan('<project-name>')} [options]

  ${bold('Options:')}
    --api                     Headless REST API template
    --web                     Full-stack template with Vue islands and views
    --template, -t ${dim('api|web')}    Alias for --api / --web
    --db ${dim('<name>')}               Database name (default: project name)
    -h, --help                Show this help message

  ${bold('Examples:')}
    bunx @strav/spring my-blog --web
    bunx @strav/spring my-api --api
    bunx @strav/spring my-app              ${dim('# interactive prompt')}
  `)
}

function toSnakeCase(name: string): string {
  return name
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/[-\s]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
}

// ── Main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs()

  if (args.help) {
    printUsage()
    process.exit(0)
  }

  console.log()
  console.log(`  ${bold('@strav/spring')} ${dim(`v${VERSION}`)}`)
  console.log(`  ${dim('The Laravel of the Bun ecosystem')}`)
  console.log()

  // Project name
  if (!args.projectName) {
    printUsage()
    process.exit(1)
  }

  const projectName = args.projectName
  const root = resolve(projectName)

  // Validate
  if (existsSync(root)) {
    console.error(red(`  Directory "${projectName}" already exists.`))
    process.exit(1)
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(projectName)) {
    console.error(
      red(`  Invalid project name. Use only letters, numbers, hyphens, and underscores.`)
    )
    process.exit(1)
  }

  // Template
  let template = args.template
  if (!template) {
    template = (await select('Which template?', [
      { label: 'web', value: 'web', description: 'Full-stack with Vue islands, views, and sessions' },
      { label: 'api', value: 'api', description: 'Headless REST API with CORS enabled' },
    ])) as 'api' | 'web'
  }

  // Database name
  const defaultDb = toSnakeCase(projectName)
  const dbName = args.db ?? defaultDb

  console.log()

  // Scaffold
  const opts: ScaffoldOptions = { projectName, template, dbName }
  await scaffold(root, opts)
  console.log(`  ${green('+')} Scaffolded project files`)

  // Install dependencies
  console.log(`  ${dim('...')} Installing dependencies`)
  const install = Bun.spawn(['bun', 'install'], { cwd: root, stdout: 'ignore', stderr: 'pipe' })
  const exitCode = await install.exited

  if (exitCode !== 0) {
    const stderr = await new Response(install.stderr).text()
    console.error(red(`  Failed to install dependencies:`))
    console.error(dim(`  ${stderr}`))
    process.exit(1)
  }

  console.log(`  ${green('+')} Installed dependencies`)

  // Done
  console.log()
  console.log(`  ${green('Project created successfully!')}`)
  console.log()
  console.log(`  Next steps:`)
  console.log()
  console.log(`    ${dim('$')} cd ${projectName}`)
  console.log(`    ${dim('$')} bun --hot index.ts`)
  console.log()
  console.log(`  ${dim('Then open http://localhost:3000')}`)
  console.log()
}

main().catch(err => {
  console.error(red(`  Error: ${err instanceof Error ? err.message : err}`))
  process.exit(1)
})