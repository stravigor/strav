import type { Command } from 'commander'
import chalk from 'chalk'
import { bootstrap, shutdown } from '@strav/cli'
import { BaseModel } from '@strav/database'
import SearchManager from '../search_manager.ts'
import { EmbeddedDriver } from '../drivers/embedded/index.ts'

export function register(program: Command): void {
  program
    .command('search:optimize <model>')
    .description("Merge FTS5 segments for a model's index (embedded driver only)")
    .action(async (modelPath: string) => {
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

        if (!(engine instanceof EmbeddedDriver)) {
          console.error(
            chalk.red(
              `search:optimize is only meaningful for the embedded driver (current: ${engine.name}).`
            )
          )
          process.exit(1)
        }

        console.log(chalk.dim(`Optimizing "${indexName}"...`))
        engine.optimize(indexName)
        console.log(chalk.green(`Optimized "${indexName}".`))
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`))
        process.exit(1)
      } finally {
        if (db) await shutdown(db)
      }
    })
}
