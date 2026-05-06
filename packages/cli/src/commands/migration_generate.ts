import type { Command } from 'commander'
import chalk from 'chalk'
import { bootstrap, shutdown } from '../cli/bootstrap.ts'
import SchemaDiffer from '@strav/database/database/migration/differ'
import SqlGenerator from '@strav/database/database/migration/sql_generator'
import MigrationFileGenerator from '@strav/database/database/migration/file_generator'
import { getDatabasePaths } from '../config/loader.ts'

export function register(program: Command): void {
  program
    .command('generate:migration')
    .aliases(['migration:generate', 'g:migration'])
    .description('Generate migration files from schema changes')
    .option('-m, --message <message>', 'Migration message', 'migration')
    .action(async (opts: { message: string }) => {
      let db
      try {
        const dbPaths = await getDatabasePaths()
        const { db: database, registry, introspector } = await bootstrap()
        db = database

        console.log(chalk.cyan('Comparing schema with database...'))

        const desired = registry.buildRepresentation(
          database.tenantIdType,
          database.tenantTableName,
          database.tenantFkColumn
        )
        const actual = await introspector.introspect()
        const diff = new SchemaDiffer().diff(desired, actual)

        const hasChanges =
          diff.enums.length > 0 ||
          diff.tables.length > 0 ||
          diff.constraints.length > 0 ||
          diff.indexes.length > 0

        if (!hasChanges) {
          console.log(chalk.green('No changes detected. Schema is in sync with the database.'))
          return
        }

        const sql = new SqlGenerator(
          database.tenantIdType,
          database.tenantTableName,
          database.tenantFkColumn
        ).generate(diff)
        const version = Date.now().toString()
        const tableOrder = desired.tables.map(t => t.name)

        const fileGen = new MigrationFileGenerator(dbPaths.migrations)
        const dir = await fileGen.generate(version, opts.message, sql, diff, tableOrder)

        console.log(chalk.green(`\nMigration generated: ${version}`))
        console.log(chalk.dim(`  Directory: ${dir}`))
        console.log(chalk.dim(`  Message: ${opts.message}\n`))

        const counts: string[] = []
        const creates = diff.tables.filter(t => t.kind === 'create').length
        const drops = diff.tables.filter(t => t.kind === 'drop').length
        const modifies = diff.tables.filter(t => t.kind === 'modify').length
        if (creates > 0) counts.push(chalk.green(`${creates} table(s) to create`))
        if (drops > 0) counts.push(chalk.red(`${drops} table(s) to drop`))
        if (modifies > 0) counts.push(chalk.yellow(`${modifies} table(s) to modify`))

        const enumCreates = diff.enums.filter(e => e.kind === 'create').length
        const enumDrops = diff.enums.filter(e => e.kind === 'drop').length
        const enumModifies = diff.enums.filter(e => e.kind === 'modify').length
        if (enumCreates > 0) counts.push(chalk.green(`${enumCreates} enum(s) to create`))
        if (enumDrops > 0) counts.push(chalk.red(`${enumDrops} enum(s) to drop`))
        if (enumModifies > 0) counts.push(chalk.yellow(`${enumModifies} enum(s) to modify`))

        if (diff.constraints.length > 0)
          counts.push(`${diff.constraints.length} constraint change(s)`)
        if (diff.indexes.length > 0) counts.push(`${diff.indexes.length} index change(s)`)

        console.log('  Summary: ' + counts.join(', '))
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`))
        process.exit(1)
      } finally {
        if (db) await shutdown(db)
      }
    })
}
