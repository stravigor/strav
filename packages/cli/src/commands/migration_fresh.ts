import type { Command } from 'commander'
import chalk from 'chalk'
import { createInterface } from 'node:readline'
import { rmSync } from 'node:fs'
import { bootstrap, shutdown } from '../cli/bootstrap.ts'
import type Database from '@strav/database/database/database'
import type SchemaRegistry from '@strav/database/schema/registry'
import type DatabaseIntrospector from '@strav/database/database/introspector'
import SchemaDiffer from '@strav/database/database/migration/differ'
import SqlGenerator from '@strav/database/database/migration/sql_generator'
import MigrationFileGenerator from '@strav/database/database/migration/file_generator'
import MigrationTracker from '@strav/database/database/migration/tracker'
import MigrationRunner from '@strav/database/database/migration/runner'
import { getDatabasePaths } from '../config/loader.ts'

/**
 * Drop all tables and enum types, regenerate a single migration from
 * the current schema definitions, and run it.
 *
 * Shared by `fresh` and `seed --fresh`.
 */
export async function freshDatabase(
  db: Database,
  registry: SchemaRegistry,
  introspector: DatabaseIntrospector,
  migrationsPath: string = 'database/migrations'
): Promise<number> {
  console.log(chalk.cyan('\nDropping all tables and types...'))

  const conn = db.isMultiTenant ? db.bypass : db.sql

  const tables = await conn.unsafe(`
    SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `)
  for (const row of tables as Array<{ table_name: string }>) {
    await conn.unsafe(`DROP TABLE IF EXISTS "${row.table_name}" CASCADE`)
  }

  const types = await conn.unsafe(`
    SELECT t.typname
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'public'
      AND t.typtype = 'e'
  `)
  for (const row of types as Array<{ typname: string }>) {
    await conn.unsafe(`DROP TYPE IF EXISTS "${row.typname}" CASCADE`)
  }

  console.log(chalk.cyan('Clearing migration directory...'))
  rmSync(migrationsPath, { recursive: true, force: true })

  console.log(chalk.cyan('Generating fresh migration...'))

  const desired = registry.buildRepresentation()
  const actual = await introspector.introspect()
  const diff = new SchemaDiffer().diff(desired, actual)

  const sql = new SqlGenerator().generate(diff)
  const version = Date.now().toString()
  const tableOrder = desired.tables.map(t => t.name)

  const fileGen = new MigrationFileGenerator(migrationsPath)
  await fileGen.generate(version, 'fresh', sql, diff, tableOrder)

  console.log(chalk.cyan('Running migration...'))

  const tracker = new MigrationTracker(db)
  const runner = new MigrationRunner(db, tracker, migrationsPath)
  const result = await runner.run()

  return result.applied.length
}

/**
 * Guard that ensures APP_ENV is "local". Exits the process if not.
 */
export function requireLocalEnv(commandName: string): void {
  const appEnv = process.env.APP_ENV
  if (appEnv !== 'local') {
    console.error(
      chalk.red('REJECTED: ') + `${commandName} can only run when APP_ENV is set to "local".`
    )
    if (!appEnv) {
      console.error(chalk.dim('  APP_ENV is not defined in .env'))
    } else {
      console.error(chalk.dim(`  Current APP_ENV: "${appEnv}"`))
    }
    process.exit(1)
  }
}

export function register(program: Command): void {
  program
    .command('fresh')
    .alias('migration:fresh')
    .description('Reset database and migrations, regenerate and run from scratch')
    .action(async () => {
      requireLocalEnv('fresh')

      // 6-digit challenge
      const challenge = String(Math.floor(100000 + Math.random() * 900000))
      console.log(
        chalk.red('WARNING: ') +
          'This will ' +
          chalk.red('destroy ALL data') +
          ' in the database and recreate everything from schemas.'
      )
      console.log(`\n  Type ${chalk.yellow(challenge)} to confirm:\n`)

      const answer = await prompt('  > ')
      if (answer.trim() !== challenge) {
        console.error(chalk.red('\nChallenge code does not match. Operation cancelled.'))
        process.exit(1)
      }

      let db
      try {
        const dbPaths = await getDatabasePaths()
        const { db: database, registry, introspector } = await bootstrap()
        db = database

        const applied = await freshDatabase(db, registry, introspector, dbPaths.migrations)

        console.log(chalk.green(`\nFresh migration complete. Applied ${applied} migration(s).`))
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`))
        process.exit(1)
      } finally {
        if (db) await shutdown(db)
      }
    })
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close()
      resolve(answer)
    })
  })
}
