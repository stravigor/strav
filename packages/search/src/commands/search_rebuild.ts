import type { Command } from 'commander'
import chalk from 'chalk'
import { bootstrap, shutdown } from '@strav/cli'
import { BaseModel } from '@strav/database'
import SearchManager from '../search_manager.ts'
import { PostgresFtsDriver } from '../drivers/postgres/index.ts'

export function register(program: Command): void {
  program
    .command('search:rebuild <model>')
    .description("Recompute a model's fts column in place (postgres-fts driver only)")
    .option('--no-reindex', "Skip the GIN REINDEX after the rebuild")
    .option('--pause <ms>', 'Pause between batches in tier-2 mode (default 50)', '50')
    .action(async (modelPath: string, options: { reindex: boolean; pause: string }) => {
      let db
      try {
        const { db: database, config } = await bootstrap()
        db = database

        new BaseModel(db)
        new SearchManager(config)

        const resolved = require.resolve(`${process.cwd()}/${modelPath}`)
        const module = await import(resolved)
        const ModelClass = module.default ?? (Object.values(module)[0] as any)

        if (typeof ModelClass?.searchableAs !== 'function') {
          console.error(chalk.red(`Model "${modelPath}" does not use the searchable() mixin.`))
          process.exit(1)
        }

        const indexName = SearchManager.indexName(ModelClass.searchableAs())
        const engine = SearchManager.engine()

        if (!(engine instanceof PostgresFtsDriver)) {
          console.error(
            chalk.red(
              `search:rebuild is only meaningful for the postgres-fts driver (current: ${engine.name}).`
            )
          )
          process.exit(1)
        }

        // Make sure the engine knows about the model's settings (so rebuild
        // computes fts with the right weights/language).
        const settings = (ModelClass.searchableSettings?.() ?? undefined) as any
        if (settings) await engine.createIndex(indexName, settings)

        console.log(chalk.dim(`Rebuilding "${indexName}"...`))
        const result = await engine.rebuild(indexName, {
          reindex: options.reindex !== false,
          pauseMs: Number(options.pause),
          onProgress: (done, total) => {
            const pct = total > 0 ? Math.round((done / total) * 100) : 100
            process.stdout.write(`\r  ${done}/${total} rows (${pct}%) `)
          },
        })
        if (result.tier === 2) process.stdout.write('\n')

        console.log(
          chalk.green(
            `Rebuilt ${result.rows} row(s) in "${indexName}" using tier-${result.tier} ` +
              `strategy (${result.elapsedMs}ms).`
          )
        )
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`))
        process.exit(1)
      } finally {
        if (db) await shutdown(db)
      }
    })
}
