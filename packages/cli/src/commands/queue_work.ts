import type { Command } from 'commander'
import chalk from 'chalk'
import path from 'node:path'
import { bootstrap, shutdown, withProviders } from '../cli/bootstrap.ts'
import type Application from '@strav/kernel/core/application'
import type ServiceProvider from '@strav/kernel/core/service_provider'
import type Database from '@strav/database/database/database'
import Queue from '@strav/queue/queue/queue'
import QueueProvider from '@strav/queue/providers/queue_provider'
import Worker from '@strav/queue/queue/worker'

/**
 * Conventional file the worker loads on start. Its top-level `Queue.handle(...)`
 * calls register the job handlers, and its `providers` export lists the service
 * providers the worker boots — mirroring `start/providers.ts` for the web entry.
 */
const JOBS_FILE = 'start/jobs.ts'

export function register(program: Command): void {
  program
    .command('queue:work')
    .description('Start processing queued jobs')
    .option('--queue <name>', 'Queue to process', 'default')
    .option('--sleep <ms>', 'Poll interval in milliseconds', '1000')
    .action(async options => {
      const queue = options.queue
      const sleep = parseInt(options.sleep)

      let app: Application | undefined
      let db: Database | undefined

      try {
        const jobsPath = path.resolve(JOBS_FILE)

        if (await Bun.file(jobsPath).exists()) {
          // Importing start/jobs.ts runs its top-level Queue.handle(...) calls
          // and exposes the provider list the worker needs. Booting those
          // providers wires the facades (mail, notification, …) that handlers
          // depend on — bootstrap() alone leaves them unregistered.
          const jobs = await import(jobsPath)
          const providers: ServiceProvider[] = Array.isArray(jobs.providers)
            ? [...jobs.providers]
            : []

          if (providers.length === 0) {
            throw new Error(
              `${JOBS_FILE} must export a \`providers\` array — the service ` +
                `providers the worker boots (ConfigProvider, DatabaseProvider, ` +
                `QueueProvider, plus any facade providers your handlers use).`,
            )
          }

          // QueueProvider wires the Queue singleton and ensures the tables —
          // add it if the app's provider list left it out.
          if (!providers.some(p => p.name === 'queue')) {
            providers.push(new QueueProvider())
          }

          // signalHandlers: false — the Worker installs its own SIGINT/SIGTERM
          // handlers that drain the in-flight job before start() returns. We
          // call app.shutdown() only afterwards (in finally), so providers are
          // never torn down while a job is still running.
          app = await withProviders(providers, { signalHandlers: false })
        } else {
          console.warn(
            chalk.yellow(`No ${JOBS_FILE} found — the worker has no registered handlers.`),
          )
          console.warn(
            chalk.dim(
              `  Create ${JOBS_FILE} with your Queue.handle(...) calls and a ` +
                `\`providers\` export, or every dispatched job will fail.`,
            ),
          )
          const { db: database, config } = await bootstrap()
          db = database
          new Queue(db, config)
          await Queue.ensureTables()
        }

        const handlers = [...Queue.handlers.keys()]

        console.log(chalk.cyan(`Worker starting on queue "${queue}"...`))
        console.log(chalk.dim(`  poll interval: ${sleep}ms`))
        console.log(
          chalk.dim(`  handlers: ${handlers.length > 0 ? handlers.join(', ') : 'none'}`),
        )
        console.log(chalk.dim('  Press Ctrl+C to stop.\n'))

        const worker = new Worker({ queue, sleep })
        await worker.start()

        console.log(chalk.dim('\nWorker stopped.'))
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`))
        process.exit(1)
      } finally {
        if (app) await app.shutdown()
        if (db) await shutdown(db)
      }
    })
}
