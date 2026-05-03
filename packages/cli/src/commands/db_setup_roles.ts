import type { Command } from 'commander'
import chalk from 'chalk'
import Configuration from '@strav/kernel/config/configuration'
import { SQL } from 'bun'
import { env } from '@strav/kernel/helpers/env'

/**
 * Emit (or apply) the SQL needed to set up the two PostgreSQL roles
 * required by the multi-tenant RLS workflow:
 *
 *   - app role:    NOBYPASSRLS — used by the application; RLS policies apply.
 *   - bypass role: BYPASSRLS   — used by migrations, TenantManager, withoutTenant().
 *
 * Reads the desired role names/passwords from the loaded Configuration
 * (`database.username`, `database.password`, `database.tenant.bypass.username`,
 * `database.tenant.bypass.password`).
 *
 * Must be run by a PostgreSQL superuser (only the superuser can grant the
 * BYPASSRLS attribute). Pass --apply to execute against the configured
 * database; otherwise the SQL is printed for manual review.
 */
export function register(program: Command): void {
  program
    .command('db:setup-roles')
    .description('Print or apply the SQL to create the app + bypass PostgreSQL roles')
    .option('--apply', 'Execute the SQL against the database (requires superuser credentials)')
    .option('--superuser <name>', 'Superuser to connect as when --apply is set', 'postgres')
    .option('--superuser-password <password>', 'Superuser password (or read from $DB_SUPERUSER_PASSWORD)')
    .action(async (opts: { apply?: boolean; superuser: string; superuserPassword?: string }) => {
      try {
        const config = new Configuration('./config')
        await config.load()

        const dbName = config.get('database.database') ?? env('DB_DATABASE', 'strav')
        const appUser = config.get('database.username') ?? env('DB_USER', 'strav_app')
        const appPassword = config.get('database.password') ?? env('DB_PASSWORD', 'changeme')
        const bypassUser =
          config.get('database.tenant.bypass.username') ?? env('DB_BYPASS_USER', 'strav_admin')
        const bypassPassword =
          config.get('database.tenant.bypass.password') ?? env('DB_BYPASS_PASSWORD', 'changeme')

        const stmts = [
          `CREATE ROLE "${appUser}" LOGIN PASSWORD '${appPassword}' NOBYPASSRLS;`,
          `CREATE ROLE "${bypassUser}" LOGIN PASSWORD '${bypassPassword}' BYPASSRLS;`,
          `GRANT ALL ON DATABASE "${dbName}" TO "${appUser}", "${bypassUser}";`,
          `GRANT ALL ON SCHEMA public TO "${appUser}", "${bypassUser}";`,
          `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO "${appUser}", "${bypassUser}";`,
          `ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO "${appUser}", "${bypassUser}";`,
        ]

        if (!opts.apply) {
          console.log(chalk.cyan('\n-- Run as a PostgreSQL superuser:\n'))
          for (const s of stmts) console.log(s)
          console.log(
            chalk.dim('\n(Use --apply to execute these against the configured database.)')
          )
          return
        }

        const password = opts.superuserPassword ?? env('DB_SUPERUSER_PASSWORD', '')
        const sql = new SQL({
          hostname: config.get('database.host') ?? env('DB_HOST', '127.0.0.1'),
          port: config.get('database.port') ?? env.int('DB_PORT', 5432),
          username: opts.superuser,
          password,
          database: dbName,
          max: 1,
        })

        console.log(chalk.cyan(`Applying role setup as superuser "${opts.superuser}"...`))
        for (const stmt of stmts) {
          try {
            await sql.unsafe(stmt)
            console.log(chalk.dim(`  ok: ${stmt}`))
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            if (/already exists/i.test(msg)) {
              console.log(chalk.dim(`  skip (exists): ${stmt}`))
            } else {
              throw err
            }
          }
        }
        await sql.close()
        console.log(chalk.green('\nRoles set up.'))
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`))
        process.exit(1)
      }
    })
}
