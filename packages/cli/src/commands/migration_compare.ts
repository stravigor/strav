import type { Command } from 'commander'
import chalk from 'chalk'
import { bootstrap, shutdown } from '../cli/bootstrap.ts'
import SchemaDiffer from '@strav/database/database/migration/differ'

export function register(program: Command): void {
  program
    .command('compare')
    .alias('migration:compare')
    .description('Compare schema with database and report differences')
    .action(async () => {
      let db
      try {
        const { db: database, registry, introspector } = await bootstrap()
        db = database

        console.log(chalk.cyan('Comparing schema with database...\n'))

        const desired = registry.buildRepresentation(database.tenantIdType)
        const actual = await introspector.introspect()
        const diff = new SchemaDiffer().diff(desired, actual)

        const hasChanges =
          diff.enums.length > 0 ||
          diff.tables.length > 0 ||
          diff.constraints.length > 0 ||
          diff.indexes.length > 0

        if (!hasChanges) {
          console.log(chalk.green('Schema is in sync with the database.'))
          return
        }

        // --- Enum changes ---
        if (diff.enums.length > 0) {
          console.log(chalk.bold('Enum changes:'))
          for (const e of diff.enums) {
            if (e.kind === 'create') {
              console.log(chalk.green(`  + CREATE  ${e.name} (${e.values.join(', ')})`))
            } else if (e.kind === 'drop') {
              console.log(chalk.red(`  - DROP    ${e.name}`))
            } else if (e.kind === 'modify') {
              console.log(chalk.yellow(`  ~ MODIFY  ${e.name} (add: ${e.addedValues.join(', ')})`))
            }
          }
          console.log()
        }

        // --- Table changes ---
        if (diff.tables.length > 0) {
          console.log(chalk.bold('Table changes:'))
          for (const t of diff.tables) {
            if (t.kind === 'create') {
              console.log(
                chalk.green(`  + CREATE  ${t.table.name}`) +
                  chalk.dim(` (${t.table.columns.length} columns)`)
              )
            } else if (t.kind === 'drop') {
              console.log(chalk.red(`  - DROP    ${t.table.name}`))
            } else if (t.kind === 'modify') {
              console.log(chalk.yellow(`  ~ MODIFY  ${t.tableName}`))
              for (const c of t.columns) {
                if (c.kind === 'add') {
                  console.log(
                    chalk.green(
                      `      + ADD COLUMN    ${c.column.name} (${typeof c.column.pgType === 'string' ? c.column.pgType : 'custom'})`
                    )
                  )
                } else if (c.kind === 'drop') {
                  console.log(chalk.red(`      - DROP COLUMN   ${c.column.name}`))
                } else if (c.kind === 'alter') {
                  const changes: string[] = []
                  if (c.typeChange) changes.push(`type: ${c.typeChange.from} -> ${c.typeChange.to}`)
                  if (c.nullableChange)
                    changes.push(c.nullableChange.to ? 'set NOT NULL' : 'drop NOT NULL')
                  if (c.defaultChange) changes.push('default changed')
                  console.log(
                    chalk.yellow(`      ~ ALTER COLUMN  ${c.columnName} (${changes.join(', ')})`)
                  )
                }
              }
            }
          }
          console.log()
        }

        // --- Constraint changes ---
        if (diff.constraints.length > 0) {
          console.log(chalk.bold('Constraint changes:'))
          for (const c of diff.constraints) {
            if (c.kind === 'add_fk') {
              console.log(
                chalk.green(
                  `  + ADD FK  ${c.tableName}(${c.constraint.columns.join(',')}) -> ${c.constraint.referencedTable}`
                )
              )
            } else if (c.kind === 'drop_fk') {
              console.log(
                chalk.red(
                  `  - DROP FK ${c.tableName}(${c.constraint.columns.join(',')}) -> ${c.constraint.referencedTable}`
                )
              )
            } else if (c.kind === 'add_unique') {
              console.log(
                chalk.green(`  + ADD UQ  ${c.tableName}(${c.constraint.columns.join(',')})`)
              )
            } else if (c.kind === 'drop_unique') {
              console.log(
                chalk.red(`  - DROP UQ ${c.tableName}(${c.constraint.columns.join(',')})`)
              )
            }
          }
          console.log()
        }

        // --- Index changes ---
        if (diff.indexes.length > 0) {
          console.log(chalk.bold('Index changes:'))
          for (const i of diff.indexes) {
            if (i.kind === 'add') {
              const unique = i.index.unique ? 'UNIQUE ' : ''
              console.log(
                chalk.green(
                  `  + CREATE ${unique}INDEX  ${i.tableName}(${i.index.columns.join(',')})`
                )
              )
            } else if (i.kind === 'drop') {
              console.log(
                chalk.red(`  - DROP INDEX    ${i.tableName}(${i.index.columns.join(',')})`)
              )
            }
          }
          console.log()
        }

        // --- Summary ---
        const creates = diff.tables.filter(t => t.kind === 'create').length
        const drops = diff.tables.filter(t => t.kind === 'drop').length
        const modifies = diff.tables.filter(t => t.kind === 'modify').length
        console.log(
          chalk.bold('Summary: ') +
            `${creates} table(s) to create, ${drops} to drop, ${modifies} to modify, ` +
            `${diff.enums.length} enum change(s), ${diff.constraints.length} constraint change(s), ${diff.indexes.length} index change(s)`
        )
        console.log(chalk.dim('\nRun "bun strav generate:migration" to create migration files.'))
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`))
        process.exit(1)
      } finally {
        if (db) await shutdown(db)
      }
    })
}
