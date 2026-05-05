import type { Command } from 'commander'
import chalk from 'chalk'
import { createInterface } from 'node:readline'
import { bootstrap, shutdown } from '../cli/bootstrap.ts'
import TenantManager from '@strav/database/database/tenant/manager'
import { ensureTenantTable } from '@strav/database/database/tenant/seed'

export function register(program: Command): void {
  program
    .command('tenant:delete <id>')
    .description('Delete a tenant and cascade-delete all their rows')
    .option('-f, --force', 'Skip the confirmation prompt')
    .action(async (id: string, opts: { force?: boolean }) => {
      let db
      try {
        const { db: database } = await bootstrap()
        db = database

        await ensureTenantTable(db.bypass, db.tenantIdType)
        const manager = new TenantManager(db)

        const tenant = await manager.find(id)
        if (!tenant) {
          console.error(chalk.red(`Tenant not found: ${id}`))
          process.exit(1)
        }

        if (!opts.force) {
          console.log(
            chalk.red('WARNING: ') +
              `This will delete tenant "${tenant.slug}" and ` +
              chalk.red('cascade-delete all their data') +
              ' across every tenant-scoped table.'
          )
          const challenge = tenant.slug
          console.log(`\n  Type ${chalk.yellow(challenge)} to confirm:\n`)

          const answer = await prompt('  > ')
          if (answer.trim() !== challenge) {
            console.error(chalk.red('\nConfirmation does not match. Operation cancelled.'))
            process.exit(1)
          }
        }

        await manager.delete(id)
        console.log(chalk.green(`\nTenant "${tenant.slug}" deleted.`))
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
