import { join } from 'node:path'
import type { Command } from 'commander'
import chalk from 'chalk'
import SchemaRegistry from '@strav/database/schema/registry'
import ApiGenerator from '../generators/api_generator.ts'
import RouteGenerator from '../generators/route_generator.ts'
import TestGenerator from '../generators/test_generator.ts'
import DocGenerator from '../generators/doc_generator.ts'
import type { ApiRoutingConfig } from '../generators/route_generator.ts'
import type { GeneratorConfig } from '../generators/config.ts'
import { loadGeneratorConfig, getDatabasePaths, loadTenantIdType } from '../config/loader.ts'

export function register(program: Command): void {
  program
    .command('generate:api')
    .alias('g:api')
    .description(
      'Generate services, controllers, policies, validators, events, and routes from schemas'
    )
    .option('-f, --force', 'Overwrite existing generated files')
    .action(async ({ force }: { force?: boolean }) => {
      try {
        console.log(chalk.cyan('Generating API layer from schemas...'))

        // Get configured database paths
        const dbPaths = await getDatabasePaths()

        const registry = new SchemaRegistry()
        await registry.discover(dbPaths.schemas)
        registry.validate()

        const schemas = registry.resolve()
        const tenantIdType = await loadTenantIdType()
        const representation = registry.buildRepresentation(tenantIdType)

        // Load generator config (if available)
        const config = await loadGeneratorConfig()

        const apiGen = new ApiGenerator(schemas, representation, config)
        const apiResult = await apiGen.writeAll(force)

        // Load API routing config from config/http.ts (if available)
        let apiConfig: Partial<ApiRoutingConfig> | undefined
        try {
          const httpConfig = (await import(join(process.cwd(), 'config/http.ts'))).default
          apiConfig = httpConfig.api
        } catch {
          // No config/http.ts or no api section — use defaults
        }

        const routeGen = new RouteGenerator(schemas, config, apiConfig)
        const routeResult = await routeGen.writeAll(force)

        const testGen = new TestGenerator(schemas, representation, config, apiConfig)
        const testResult = await testGen.writeAll(force)

        const docGen = new DocGenerator(schemas, representation, config, apiConfig)
        const docResult = await docGen.writeAll(force)

        const written = [
          ...apiResult.written,
          ...routeResult.written,
          ...testResult.written,
          ...docResult.written,
        ]
        const skipped = [
          ...apiResult.skipped,
          ...routeResult.skipped,
          ...testResult.skipped,
          ...docResult.skipped,
        ]

        if (written.length === 0 && skipped.length === 0) {
          console.log(chalk.yellow('No API files to generate.'))
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
