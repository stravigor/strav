# MCP

Model Context Protocol (MCP) server for the Strav framework. Expose your application's capabilities to AI clients like Claude Desktop through **tools**, **resources**, and **prompts**. Supports both **stdio** (local AI clients) and **HTTP** (hosted deployments) transports.

## Installation

```bash
bun add @strav/mcp
bun strav install mcp
```

The `install` command copies `config/mcp.ts` into your project. The file is yours to edit.

## Setup

### 1. Register McpManager

#### Using a service provider (recommended)

```typescript
import { McpProvider } from '@strav/mcp'

app.use(new McpProvider())
```

The `McpProvider` registers `McpManager` as a singleton. It depends on the `config` provider, loads your registration file, and auto-mounts the HTTP transport on the router.

To disable HTTP transport auto-mounting:

```typescript
app.use(new McpProvider({ mountHttp: false }))
```

#### Manual setup

```typescript
import McpManager from '@strav/mcp'

app.singleton(McpManager)
app.resolve(McpManager)
```

### 2. Configure

Edit `config/mcp.ts`:

```typescript
import { env } from '@strav/kernel'

export default {
  name: env('MCP_NAME', undefined),
  version: env('MCP_VERSION', '1.0.0'),
  register: 'mcp/server.ts',
  http: {
    enabled: env('MCP_HTTP', 'true').bool(),
    path: env('MCP_PATH', '/mcp'),
  },
}
```

### 3. Register tools, resources, and prompts

Create the registration file referenced in your config (e.g. `mcp/server.ts`):

```typescript
import { mcp } from '@strav/mcp'
import { z } from 'zod'
import Database from '@strav/database'

// Tool — an action the AI can invoke
mcp.tool('get-user', {
  description: 'Fetch a user by ID',
  input: { id: z.number() },
  handler: async ({ id }, { app }) => {
    const db = app.resolve(Database)
    const [user] = await db.sql`SELECT * FROM users WHERE id = ${id}`
    return { content: [{ type: 'text', text: JSON.stringify(user) }] }
  },
})

// Resource — data the AI can read
mcp.resource('strav://schema', {
  name: 'Database schema',
  description: 'Current database schema overview',
  mimeType: 'application/json',
  handler: async (uri, params, { app }) => {
    return { contents: [{ uri: uri.href, text: '{ "tables": [...] }' }] }
  },
})

// Prompt — a reusable prompt template
mcp.prompt('summarize', {
  description: 'Summarize a topic',
  args: { topic: z.string() },
  handler: async ({ topic }) => ({
    messages: [{
      role: 'user',
      content: { type: 'text', text: `Summarize: ${topic}` },
    }],
  }),
})
```

## Tools

Tools are functions that AI clients can call. Define typed inputs with Zod schemas.

```typescript
import { mcp } from '@strav/mcp'
import { z } from 'zod'

mcp.tool('create-post', {
  description: 'Create a new blog post',
  input: {
    title: z.string().describe('Post title'),
    body: z.string().describe('Post body in markdown'),
    published: z.boolean().optional().describe('Publish immediately'),
  },
  handler: async ({ title, body, published }, { app }) => {
    const post = await Post.create({ title, body, published })
    return {
      content: [{ type: 'text', text: `Created post #${post.id}: ${post.title}` }],
    }
  },
})
```

Tools without input schemas are also supported:

```typescript
mcp.tool('list-posts', {
  description: 'List all published posts',
  handler: async (params, { app }) => {
    const posts = await Post.where('published', true).get()
    return {
      content: [{ type: 'text', text: JSON.stringify(posts) }],
    }
  },
})
```

## Resources

Resources expose data via URIs. Use URI templates for dynamic resources.

```typescript
// Static resource
mcp.resource('strav://config', {
  name: 'App configuration',
  description: 'Current application configuration',
  mimeType: 'application/json',
  handler: async (uri) => ({
    contents: [{ uri: uri.href, text: JSON.stringify({ env: 'production' }) }],
  }),
})

// Dynamic resource with URI template
mcp.resource('strav://posts/{id}', {
  name: 'Blog post',
  description: 'A blog post by ID',
  mimeType: 'application/json',
  handler: async (uri, { id }, { app }) => {
    const post = await Post.find(Number(id))
    return {
      contents: [{ uri: uri.href, text: JSON.stringify(post) }],
    }
  },
})
```

## Prompts

Prompts are reusable templates with typed arguments.

```typescript
mcp.prompt('code-review', {
  description: 'Review code and suggest improvements',
  args: {
    language: z.string(),
    code: z.string(),
  },
  handler: async ({ language, code }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Review this ${language} code and suggest improvements:\n\n${code}`,
      },
    }],
  }),
})
```

## Transports

### Stdio (Claude Desktop)

For local AI clients that communicate over stdin/stdout. Start with the CLI:

```bash
bun strav mcp:serve
```

Add to your Claude Desktop config (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "my-app": {
      "command": "bun",
      "args": ["strav", "mcp:serve"],
      "cwd": "/path/to/your/app"
    }
  }
}
```

### HTTP (hosted deployments)

For web-based AI clients. Enabled by default when using the provider. Mounts `POST`, `GET`, and `DELETE` handlers at the configured path (default: `/mcp`).

```typescript
import { mountHttpTransport } from '@strav/mcp'
import { router } from '@strav/http'

const transport = mountHttpTransport(router)
```

## Handler context

Every handler receives a `ToolHandlerContext` with access to the DI container:

```typescript
mcp.tool('send-email', {
  description: 'Send an email to a user',
  input: { userId: z.number(), subject: z.string(), body: z.string() },
  handler: async ({ userId, subject, body }, { app }) => {
    const db = app.resolve(Database)
    const mailer = app.resolve(MailManager)

    const [user] = await db.sql`SELECT * FROM users WHERE id = ${userId}`
    await mailer.to(user.email).subject(subject).text(body).send()

    return { content: [{ type: 'text', text: `Email sent to ${user.email}` }] }
  },
})
```

## Inspection

List what's registered:

```typescript
import { mcp } from '@strav/mcp'

mcp.registeredTools()      // ['get-user', 'create-post', ...]
mcp.registeredResources()  // ['strav://config', 'strav://posts/{id}', ...]
mcp.registeredPrompts()    // ['summarize', 'code-review', ...]

// Get a specific registration
const tool = mcp.getToolRegistration('get-user')
// { name: 'get-user', description: '...', input: {...}, handler: [Function] }
```

## Events

MCP operations emit events through the `Emitter`:

| Event | Payload | When |
|---|---|---|
| `mcp:tool-registered` | `{ name }` | Tool registered |
| `mcp:resource-registered` | `{ uri }` | Resource registered |
| `mcp:prompt-registered` | `{ name }` | Prompt registered |
| `mcp:tool-called` | `{ name, params }` | Tool invoked by AI client |
| `mcp:resource-read` | `{ uri }` | Resource read by AI client |
| `mcp:prompt-called` | `{ name, args }` | Prompt used by AI client |
| `mcp:stdio-starting` | — | Stdio transport starting |
| `mcp:stdio-connected` | — | Stdio transport connected |
| `mcp:stdio-closed` | — | Stdio transport closed |
| `mcp:http-mounted` | `{ path }` | HTTP transport mounted |
| `mcp:http-request` | `{ method, path }` | HTTP request received |

```typescript
import Emitter from '@strav/kernel'

Emitter.on('mcp:tool-called', ({ name, params }) => {
  console.log(`Tool "${name}" called with`, params)
})
```

## CLI commands

| Command | Description |
|---|---|
| `bun strav mcp:serve` | Start the MCP server in stdio mode |
| `bun strav mcp:list` | List all registered tools, resources, and prompts |

## Testing

Call `McpManager.reset()` in test teardown to clear all registrations:

```typescript
import { beforeEach, test, expect } from 'bun:test'
import McpManager, { mcp } from '@strav/mcp'

beforeEach(() => {
  McpManager.reset()
})

test('registers a tool', () => {
  mcp.tool('test-tool', {
    description: 'A test tool',
    handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  })

  expect(mcp.registeredTools()).toEqual(['test-tool'])
})
```

## Full example

```typescript
// mcp/server.ts
import { mcp } from '@strav/mcp'
import { z } from 'zod'
import Database from '@strav/database'

mcp.tool('list-users', {
  description: 'List all users with optional role filter',
  input: { role: z.string().optional() },
  handler: async ({ role }, { app }) => {
    const db = app.resolve(Database)
    const users = role
      ? await db.sql`SELECT id, name, email FROM users WHERE role = ${role}`
      : await db.sql`SELECT id, name, email FROM users`
    return { content: [{ type: 'text', text: JSON.stringify(users) }] }
  },
})

mcp.tool('update-user', {
  description: 'Update a user field',
  input: {
    id: z.number(),
    field: z.enum(['name', 'email', 'role']),
    value: z.string(),
  },
  handler: async ({ id, field, value }, { app }) => {
    const db = app.resolve(Database)
    await db.sql`UPDATE users SET ${db.sql(field)} = ${value} WHERE id = ${id}`
    return { content: [{ type: 'text', text: `Updated user #${id}` }] }
  },
})

mcp.resource('strav://users/{id}', {
  name: 'User profile',
  description: 'User details by ID',
  handler: async (uri, { id }, { app }) => {
    const db = app.resolve(Database)
    const [user] = await db.sql`SELECT * FROM users WHERE id = ${Number(id)}`
    return { contents: [{ uri: uri.href, text: JSON.stringify(user) }] }
  },
})

mcp.prompt('onboard-user', {
  description: 'Generate an onboarding email for a new user',
  args: { name: z.string(), role: z.string() },
  handler: async ({ name, role }) => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: `Write a friendly onboarding email for ${name} who joined as ${role}.`,
      },
    }],
  }),
})
```
