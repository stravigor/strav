# Strav Framework

**The Modern, AI-First Backend Framework for Bun**

Strav is a comprehensive, modular framework built from the ground up for the Bun runtime. Designed for modern applications that need enterprise-grade features, AI capabilities, and exceptional developer experience.

## Why Strav?

- **🚀 Bun-Native Performance** — Built specifically for Bun's speed and efficiency
- **🧠 AI-First Architecture** — Multi-provider AI integration (Anthropic, OpenAI, DeepSeek) with tool use
- **🏢 Enterprise-Grade Features** — OAuth2 server, multi-tenant database, billing integration, full-text search
- **🎯 Full-Stack Ready** — Backend framework with Vue islands for modern web applications
- **📦 Modular Monorepo** — 20+ focused packages with clean dependency separation
- **🛠️ Exceptional DX** — Rich CLI tooling, code generators, and testing utilities
- **🔧 Modern Patterns** — IoC container, dependency injection, and event-driven architecture

## Core Features

### Foundation Layer
- **Application Lifecycle** — IoC container, dependency injection, configuration management
- **HTTP Layer** — Router, middleware, authentication, sessions, validation, policies
- **Database** — Query builder, ORM, schema builder, migrations, multi-tenant support
- **View Engine** — Template engine with Vue SFC islands and SPA routing
- **Background Processing** — Job queues and task scheduling
- **Communication** — Mail, notifications, and real-time broadcasting
- **CLI Framework** — Command-line tools and code generators

### Extended Capabilities
- **AI Integration** — Multi-provider AI support with agents, tool use, and structured output
- **OAuth2 Server** — Complete authorization server implementation
- **Billing Integration** — Stripe subscriptions, payments, and webhooks
- **Full-Text Search** — Unified API for Meilisearch, Typesense, and Algolia
- **Social Authentication** — OAuth providers (Google, GitHub, Discord, Facebook, LinkedIn)
- **Workflow Orchestration** — Multi-step processes with saga-style compensation
- **Testing Utilities** — Test cases with automatic transaction isolation

## Quick Start

```bash
# Install dependencies
bun install

# Run type checking
bun run typecheck

# Run tests
bun test

# Generate new models, routes, or migrations
bun strav generate:model User --scope=public
bun strav generate:migration "add_users_table" --scope=public
bun strav migrate --scope=public
```

## Architecture

Strav follows a clean dependency graph with modular packages:

```
kernel (foundation) → http, database, view, queue, signal, cli
    ↓
Extended packages (brain, oauth2, stripe, search, social, etc.)
    ↓
Applications
```

### Core Packages

| Package | Description |
|---------|-------------|
| `@strav/kernel` | Foundation: IoC container, configuration, events, encryption, storage, cache, i18n, logger |
| `@strav/http` | HTTP layer: router, server, middleware, authentication, sessions, validation |
| `@strav/database` | Persistence: query builder, ORM, schema builder, migrations, multi-tenant support |
| `@strav/view` | View layer: template engine, Vue SFC islands, SPA client router |
| `@strav/queue` | Background processing: job queues, task scheduling |
| `@strav/signal` | Communication: mail, notifications, real-time broadcasting |
| `@strav/cli` | Developer tools: CLI framework, code generators |

### Extended Packages

| Package | Description |
|---------|-------------|
| `@strav/brain` | AI integration with multi-provider support and tool use |
| `@strav/oauth2` | Complete OAuth2 authorization server |
| `@strav/stripe` | Stripe billing integration with subscriptions and payments |
| `@strav/search` | Full-text search with multiple engine support |
| `@strav/social` | OAuth social authentication for major providers |
| `@strav/workflow` | Workflow orchestration with compensation patterns |
| `@strav/testing` | Testing utilities with transaction isolation |

## Multi-Tenant Architecture

Strav provides built-in multi-tenant support using PostgreSQL schemas:

```bash
# Generate migrations for different scopes
bun strav generate:migration "add_users_table" --scope=public
bun strav generate:migration "add_orders_table" --scope=tenants

# Run migrations
bun strav migrate --scope=public
bun strav migrate --scope=tenants
```

## AI-First Development

Built-in AI capabilities make it easy to add intelligence to your applications:

```typescript
import { brain } from '@strav/brain'

// Multi-provider AI support
const agent = brain.agent('gpt-4o')
const response = await agent.chat('Analyze this data...')

// Tool use and structured output
const result = await agent.tools([searchTool, analysisTool])
  .chat('Research and analyze...')
```

## Development Commands

```bash
# Development
bun install                    # Install dependencies
bun run typecheck             # Type check entire workspace
bun test                      # Run all tests
bun test --filter @strav/http # Test specific package

# Publishing
./scripts/publish.sh          # Publish all packages
./scripts/sync-patch-versions.sh # Bump patch versions

# Database
bun strav migrate --scope=public
bun strav generate:model User --scope=tenants
```

## Example Application Structure

```typescript
// app.ts - Application bootstrap
import { Application } from '@strav/kernel'
import { ConfigProvider, EncryptionProvider } from '@strav/kernel'
import { HttpProvider } from '@strav/http'
import { DatabaseProvider } from '@strav/database'

const app = new Application()
app.use(new ConfigProvider())
   .use(new DatabaseProvider())
   .use(new EncryptionProvider())
   .use(new HttpProvider())

await app.start()
```

## Package Architecture

Each package follows consistent patterns:
- **Barrel exports** — All public APIs exported from `src/index.ts`
- **Provider pattern** — Service providers for framework integration
- **Modular structure** — Self-contained modules with clear boundaries
- **TypeScript-first** — Full type safety throughout

## Contributing

Strav is a monorepo built with Bun workspaces. Each package is independently versioned but follows the same development workflow.

### Development Setup
1. Clone the repository
2. Run `bun install` to install dependencies
3. Run `bun run typecheck` to ensure everything builds
4. Make your changes and add tests
5. Run `bun test` to verify your changes

### Package Development
- All packages use the `@strav/` npm scope
- Use `workspace:*` for internal dependencies
- Follow the established dependency graph
- Export public APIs through barrel exports

## License

MIT License - see [LICENSE](LICENSE) for details.

---

**Built with ❤️ for the Bun ecosystem**