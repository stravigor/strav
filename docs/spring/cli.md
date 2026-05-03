# Spring CLI Commands

The `@strav/spring` package provides comprehensive CLI commands for scaffolding and managing Strav applications.

## Installation Commands

### Create New Application

```bash
bunx @strav/spring <project-name> [options]
```

**Arguments:**
- `<project-name>` - Name of the project directory to create

**Options:**
- `--api` - Generate headless REST API template
- `--web` - Generate full-stack template with Vue islands and views
- `--template, -t <type>` - Alias for `--api` / `--web`
- `--db <name>` - Database name (default: project name converted to snake_case)
- `-h, --help` - Show help message

**Examples:**

```bash
# Interactive prompt (recommended for first-time users)
bunx @strav/spring my-app

# Full-stack web application
bunx @strav/spring blog --web

# Headless REST API
bunx @strav/spring api-server --api

# Custom database name
bunx @strav/spring ecommerce --web --db=shop_database

# Using template flag
bunx @strav/spring mobile-backend --template=api
```

### Interactive Mode

When no template is specified, Spring enters interactive mode:

```
  @strav/spring v0.1.0
  The Laravel of the Bun ecosystem

  Which template?
  > web    Full-stack with Vue islands, views, and sessions
    api    Headless REST API with CORS enabled

  Database name: (my_app)
```

Use arrow keys to navigate, Enter to select, and Ctrl+C to cancel.

## Project CLI Commands

Once your application is created, use the included `strav.ts` CLI for development:

```bash
bun strav <command> [options]
```

### Schema and Database Commands

#### `make:schema`
Create a new database schema definition.

```bash
bun strav make:schema <name> [options]

# Options:
--archetype <type>     # Schema archetype (entity, component, attribute, etc.)
--parent <schema>      # Parent schema for dependent archetypes

# Examples:
bun strav make:schema user --archetype=entity
bun strav make:schema user_profile --archetype=attribute --parent=user
bun strav make:schema team_member --archetype=association
```

**Schema Archetypes:**
- `entity` - Top-level domain objects (users, posts, orders)
- `component` - Belongs to a parent entity (addresses, phone numbers)
- `attribute` - Dependent data on an entity (profiles, settings)
- `association` - Pivot tables between entities (user_roles, team_members)
- `event` - Immutable event records (audit logs, notifications)
- `reference` - Lookup/reference data (countries, categories)
- `configuration` - System configuration (app settings)
- `contribution` - User-contributed content (comments, reviews)

#### `generate:migration`
Generate migration files from schema changes.

```bash
bun strav generate:migration [options]

# Options:
--message <message>    # Migration description
-m <message>          # Short alias for --message

# Examples:
bun strav generate:migration --message="add user schema"
bun strav generate:migration -m "update post fields"
```

#### `migrate`
Run pending migrations.

```bash
bun strav migrate

# Example:
bun strav migrate
```

#### `rollback`
Roll back migrations.

```bash
bun strav rollback [options]

# Options:
--batch <number>       # Specific batch to rollback to

# Examples:
bun strav rollback             # rollback last batch
bun strav rollback --batch=3   # rollback to batch 3
```

#### `compare`
Compare schema definitions against live database.

```bash
bun strav compare

# Example:
bun strav compare
```

#### `fresh`
Drop all tables, re-run migrations, and seed database (local env only).

```bash
bun strav fresh [options]

# Options:
--seed                 # Run seeders after migrations

# Examples:
bun strav fresh
bun strav fresh --seed
```

### Code Generation Commands

#### `make:controller`
Generate a new HTTP controller.

```bash
bun strav make:controller <name> [options]

# Options:
--resource             # Generate RESTful resource controller
--api                  # Generate API controller (JSON responses only)

# Examples:
bun strav make:controller user_controller
bun strav make:controller post_controller --resource
bun strav make:controller api/user_controller --api
```

#### `make:middleware`
Generate middleware.

```bash
bun strav make:middleware <name>

# Examples:
bun strav make:middleware auth_middleware
bun strav make:middleware cors_middleware
```

#### `make:policy`
Generate authorization policy.

```bash
bun strav make:policy <name>

# Examples:
bun strav make:policy user_policy
bun strav make:policy post_policy
```

#### `make:job`
Generate background job.

```bash
bun strav make:job <name> [options]

# Options:
--sync                 # Generate synchronous job

# Examples:
bun strav make:job send_email_job
bun strav make:job process_payment_job --sync
```

#### `make:mail`
Generate mail template.

```bash
bun strav make:mail <name>

# Examples:
bun strav make:mail welcome_mail
bun strav make:mail password_reset_mail
```

#### `make:service`
Generate service class for business logic.

```bash
bun strav make:service <name>

# Examples:
bun strav make:service payment_service
bun strav make:service user_service
```

#### `make:factory`
Generate model factory for testing.

```bash
bun strav make:factory <name>

# Examples:
bun strav make:factory user_factory
bun strav make:factory post_factory
```

#### `make:seeder`
Generate database seeder.

```bash
bun strav make:seeder <name>

# Examples:
bun strav make:seeder user_seeder
bun strav make:seeder database_seeder
```

#### `make:island`
Generate Vue island component.

```bash
bun strav make:island <name> [options]

# Options:
--setup                # Use <script setup> syntax (default)
--options              # Use Options API syntax

# Examples:
bun strav make:island search_bar
bun strav make:island user_profile --setup
bun strav make:island data_table --options
```

### Model Generation Commands

#### `generate:models`
Generate ORM models from schema definitions.

```bash
bun strav generate:models [options]

# Options:
--force                # Overwrite existing models

# Examples:
bun strav generate:models
bun strav generate:models --force
```

### Database Seeding Commands

#### `seed`
Run database seeders.

```bash
bun strav seed [options]

# Options:
--class <seeder>       # Run specific seeder class
--fresh                # Fresh migrate before seeding (local env only)

# Examples:
bun strav seed                          # run default DatabaseSeeder
bun strav seed --class=UserSeeder       # run specific seeder
bun strav seed --fresh                  # fresh migrate + seed
```

### Development Commands

#### `route:list`
Display all registered routes.

```bash
bun strav route:list

# Output example:
GET     /                    HomeController@index
GET     /users               UserController@index
POST    /users               UserController@store
GET     /users/:id           UserController@show
PUT     /users/:id           UserController@update
DELETE  /users/:id           UserController@destroy
```

#### `serve`
Start development server (alias for `bun run dev`).

```bash
bun strav serve [options]

# Options:
--hot                  # Enable hot reload (default)
--port <port>          # Specify port (default: 3000)

# Examples:
bun strav serve
bun strav serve --port=8080
```

#### `build:islands`
Build Vue islands for production.

```bash
bun strav build:islands [options]

# Options:
--watch                # Watch for changes
--minify               # Minify output (default in production)

# Examples:
bun strav build:islands
bun strav build:islands --watch
```

## Configuration

### CLI Configuration

The `strav.ts` CLI can be configured through your application's config files:

```typescript
// config/cli.ts
export default {
  commands: {
    // Custom command settings
  },
  generators: {
    // Code generation settings
    modelNaming: {
      public: '',           // No prefix for public models
      tenant: 'Tenant',     // Prefix for tenant models
    }
  }
}
```

### Generator Templates

You can customize generator templates by creating them in your project:

```
stubs/
├── controller.stub
├── middleware.stub
├── policy.stub
└── island.stub
```

## Common Workflows

### Creating a New Feature

```bash
# 1. Create the schema
bun strav make:schema post --archetype=entity

# 2. Generate and run migration
bun strav generate:migration -m "add post schema"
bun strav migrate

# 3. Generate supporting code
bun strav make:controller post_controller --resource
bun strav make:policy post_policy
bun strav make:factory post_factory

# 4. Create Vue islands for interactivity
bun strav make:island post_editor
bun strav make:island comment_form
```

### Setting Up Testing Data

```bash
# 1. Create factory
bun strav make:factory user_factory

# 2. Create seeder
bun strav make:seeder user_seeder

# 3. Run seeder
bun strav seed --class=UserSeeder
```

### Database Schema Evolution

```bash
# 1. Modify schema files
# 2. Generate migration
bun strav generate:migration -m "update user schema"

# 3. Review generated migration
# 4. Run migration
bun strav migrate

# 5. Compare to ensure sync
bun strav compare
```

## Help and Debugging

### Getting Help

```bash
# General help
bunx @strav/spring --help

# Command-specific help
bun strav <command> --help
bun strav make:schema --help
bun strav migrate --help
```

### Verbose Output

Most commands support `--verbose` or `-v` for detailed output:

```bash
bun strav migrate --verbose
bun strav generate:migration -v
```

### Dry Run

Some commands support `--dry-run` to preview changes:

```bash
bun strav generate:migration --dry-run
bun strav fresh --dry-run
```

The Spring CLI provides a comprehensive set of tools for developing Strav applications efficiently, following Laravel's successful command-line interface patterns while embracing Strav's TypeScript-first philosophy.