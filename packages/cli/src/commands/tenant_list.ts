import type { Command } from 'commander'
import chalk from 'chalk'
import { bootstrap, shutdown } from '../cli/bootstrap.ts'
import TenantManager from '@strav/database/database/tenant/manager'
import { ensureTenantTable } from '@strav/database/database/tenant/seed'

export function register(program: Command): void {
  program
    .command('tenant:list')
    .description('List all tenants')
    .action(async () => {
      let db
      try {
        const { db: database } = await bootstrap()
        db = database

        await ensureTenantTable(db.bypass)
        const manager = new TenantManager(db)
        const tenants = await manager.list()

        if (tenants.length === 0) {
          console.log(chalk.yellow('No tenants found.'))
          return
        }

        console.log(chalk.cyan(`\n${tenants.length} tenant(s):\n`))
        for (const t of tenants) {
          console.log(`  ${chalk.green(t.slug)}`)
          console.log(chalk.dim(`    id:   ${t.id}`))
          console.log(chalk.dim(`    name: ${t.name}`))
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`))
        process.exit(1)
      } finally {
        if (db) await shutdown(db)
      }
    })
}
