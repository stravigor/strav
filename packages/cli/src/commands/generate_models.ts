import type { Command } from 'commander'
import chalk from 'chalk'
import SchemaRegistry from '@strav/database/schema/registry'
import ModelGenerator from '../generators/model_generator.ts'
import { loadGeneratorConfig, getDatabasePaths } from '../config/loader.ts'

export function register(program: Command): void {
  program
    .command('generate:models')
    .alias('g:models')
    .description('Generate model classes and enums from schema definitions')
    .option('-f, --force', 'Overwrite existing generated files')
    .action(async ({ force }: { force?: boolean }) => {
      try {
        const dbPaths = await getDatabasePaths()
        const config = await loadGeneratorConfig()

        console.log(chalk.cyan('Generating models from schemas...'))

        const registry = new SchemaRegistry()
        await registry.discover(dbPaths.schemas)
        registry.validate()

        const representation = registry.buildRepresentation()
        const generator = new ModelGenerator(registry.all(), representation, config)
        const { written, skipped } = await generator.writeAll(force)

        if (written.length === 0 && skipped.length === 0) {
          console.log(chalk.yellow('No models to generate.'))
          return
        }

        for (const file of written) {
          console.log(chalk.green(`  CREATE  `) + chalk.dim(file.path))
        }
        for (const file of skipped) {
          console.log(chalk.yellow(`  SKIP    `) + chalk.dim(file.path) + chalk.dim(' (already exists)'))
        }

        if (skipped.length > 0) {
          console.log(chalk.dim(`\nSkipped ${skipped.length} existing file(s). Use --force to overwrite.`))
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`))
        process.exit(1)
      }
    })
}
