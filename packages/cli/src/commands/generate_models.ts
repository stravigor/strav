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
    .action(async () => {
      try {
        const dbPaths = await getDatabasePaths()
        const config = await loadGeneratorConfig()

        console.log(chalk.cyan('Generating models from schemas...'))

        const registry = new SchemaRegistry()
        await registry.discover(dbPaths.schemas)
        registry.validate()

        const representation = registry.buildRepresentation()
        const generator = new ModelGenerator(registry.all(), representation, config)
        const files = await generator.writeAll()

        if (files.length === 0) {
          console.log(chalk.yellow('No models to generate.'))
          return
        }

        console.log(chalk.green(`\nGenerated ${files.length} file(s):`))
        for (const file of files) {
          console.log(chalk.dim(`  ${file.path}`))
        }
      } catch (err) {
        console.error(chalk.red(`Error: ${err instanceof Error ? err.message : err}`))
        process.exit(1)
      }
    })
}
