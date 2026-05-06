# @strav/cli

CLI framework and code generators for the Strav framework. Provides the `strav` binary.

## Dependencies
- @strav/kernel (peer)
- @strav/http (peer)
- @strav/database (peer)
- @strav/queue (peer)
- @strav/signal (peer)

## Commands
- bun test
- bun run typecheck

## Architecture
- src/cli/ — CLI bootstrap, command loader, strav.ts entry point
- src/commands/ — Built-in commands (migrations, queue, scheduler, generators, db seed, tenant management)
- src/generators/ — Code generators (model, route, API, test, doc)

## Database Path Configuration
Database paths for schemas and migrations are configurable via `config/generators.ts`:
- Default schemas path: `database/schemas`
- Default migrations path: `database/migrations`
- Override in config to use custom locations (e.g., `src/db/schemas`, `src/db/migrations`)

## Multi-tenant Commands
- `bun strav db:setup-roles [--apply]` — emit/apply the SQL to create the
  app + bypass PostgreSQL roles required for the RLS workflow.
- `bun strav tenant:create --slug=... --name=...` — insert a new row in
  the configured tenant registry table (`database.tenant.tableName`,
  default `tenant`).
- `bun strav tenant:list` — list registered tenants.
- `bun strav tenant:delete <id>` — delete a tenant (cascades via the FK
  on the configured tenant column, default `tenant_id`).

## Conventions
- Commands are auto-loaded by command_loader.ts
- Generators output code that imports from the split packages (@strav/kernel, @strav/http, etc.)
- The `strav` binary is declared in package.json bin field
- Migration commands route through the bypass connection so RLS policies do not filter migrations themselves.
