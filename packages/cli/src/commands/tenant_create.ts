import type { Command } from 'commander'
import chalk from 'chalk'
import { bootstrap, shutdown } from '../cli/bootstrap.ts'
import TenantManager from '@strav/database/database/tenant/manager'
import { ensureTenantTable } from '@strav/database/database/tenant/seed'

export function register(program: Command): void {
  program
    .command('tenant:create')
    .description('Create a new tenant')
    .requiredOption('--slug <slug>', 'Unique tenant slug (used for subdomain/URLs)')
    .requiredOption('--name <name>', 'Tenant display name')
    .action(async (opts: { slug: string; name: string }) => {
      let db
      try {
        const { db: database } = await bootstrap()
        db = database

        await ensureTenantTable(db.bypass, db.tenantIdType)
        const manager = new TenantManager(db)

        const tenant = await manager.create({ slug: opts.slug, name: opts.name })

        console.log(chalk.green('\nTenant created:'))
        console.log(chalk.dim(`  id:   ${tenant.id}`))
        console.log(chalk.dim(`  slug: ${tenant.slug}`))
        console.log(chalk.dim(`  name: ${tenant.name}`))
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`))
        process.exit(1)
      } finally {
        if (db) await shutdown(db)
      }
    })
}
