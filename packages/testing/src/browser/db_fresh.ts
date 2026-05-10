/**
 * Programmatic equivalent of `bun strav fresh`. Refuses to run unless the
 * caller has set APP_ENV to 'test' or 'local' — the CLI command requires
 * 'local'; we additionally accept 'test' so test runners don't need a flag
 * dance. Lazy-imports `@strav/cli` so packages that don't use BrowserTestCase
 * don't pay the dependency cost.
 */
export async function runFresh(): Promise<void> {
  const env = process.env.APP_ENV
  if (env !== 'test' && env !== 'local') {
    throw new Error(
      `runFresh refused: APP_ENV must be 'test' or 'local' (got '${env ?? '<unset>'}'). ` +
        `This is a safety guard — fresh wipes all tables.`
    )
  }

  let freshDatabase: typeof import('@strav/cli/commands/migration_fresh').freshDatabase
  let bootstrap: typeof import('@strav/cli/cli/bootstrap').bootstrap
  let shutdown: typeof import('@strav/cli/cli/bootstrap').shutdown
  let getDatabasePaths: typeof import('@strav/cli/config/loader').getDatabasePaths
  try {
    ;({ freshDatabase } = await import('@strav/cli/commands/migration_fresh'))
    ;({ bootstrap, shutdown } = await import('@strav/cli/cli/bootstrap'))
    ;({ getDatabasePaths } = await import('@strav/cli/config/loader'))
  } catch (err) {
    throw new Error(
      `runFresh requires @strav/cli to be installed in this workspace. Add it as a peer dependency. (${(err as Error).message})`
    )
  }

  const paths = await getDatabasePaths()
  const { db, registry, introspector } = await bootstrap()
  try {
    await freshDatabase(db, registry, introspector, paths.migrations)
  } finally {
    await shutdown(db)
  }
}
