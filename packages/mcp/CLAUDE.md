# @strav/mcp

Model Context Protocol (MCP) server **and client** for the Strav framework.
Expose application capabilities to AI clients through tools, resources, prompts,
and long-running tasks — and call remote MCP servers. Supports stdio (local)
and Streamable HTTP (hosted, multi-tenant) transports.

## Dependencies
- @strav/kernel (peer)
- @strav/http (peer)
- @strav/cli (peer)
- @modelcontextprotocol/sdk — the official MCP SDK (server, client, experimental Tasks)

## Commands
- bun test
- bun run build

## Architecture
- src/mcp_manager.ts — main manager class; registration + server wiring, per-call handler context, task wiring
- src/mcp_provider.ts — service provider registration; forwards `middleware` / `eventStore` / `taskStore`
- src/helpers.ts — the `mcp` convenience API (`mcp.tool/resource/prompt/task`)
- src/transports/ — stdio and Streamable-HTTP transports
  - bun_http_transport.ts — `mountHttpTransport(router, { middleware, eventStore })`
  - memory_event_store.ts — in-memory `EventStore` for resumability (single-node reference impl)
- src/tasks.ts — MCP Tasks types + SDK re-exports (`InMemoryTaskStore`, `TaskStore`)
- src/elicitation.ts — MCP Elicitation helpers (`confirmation`, `wasApproved`)
- src/client/ — MCP client (`McpClient`) for calling remote MCP servers
- src/commands/ — CLI commands
- src/types.ts — type definitions
- src/errors.ts — package-specific errors
- docs/streamable-http.md — Streamable-HTTP conformance reference

## Hosted gateway features
- **OAuth-scoped HTTP transport** — `mountHttpTransport(router, { middleware: [oauth(), scopes('mcp')] })`
  rejects unauthenticated / insufficient-scope calls (401/403) before any handler.
  The resolved caller (`oauth_token` / `oauth_client` / `user`) reaches handlers
  via `ToolHandlerContext`, carried through the SDK's `extra.authInfo`.
- **MCP Tasks** — `mcp.task(name, { handler, ttl, pollInterval })`: long-running tools
  the client fires and polls. Backed by a pluggable `TaskStore` (default in-memory;
  supply a database- or `@strav/durable`-backed store for crash-resumable tasks).
- **MCP Elicitation** — `ctx.elicit(confirmation(message))`: a handler can pause
  mid-call for a human confirmation over the server→client channel.
- **MCP client** — `McpClient` wraps the SDK client + Streamable-HTTP transport,
  with a built-in bearer-token path for OAuth-scoped gateways.

## Conventions
- Tools, resources, prompts, and tasks follow the MCP specification
- Transport layer is abstracted — handler logic is transport-agnostic; caller
  identity arrives through the SDK `extra`, which both stdio and HTTP populate
- The package stays auth-agnostic — caller-identity types (`McpCallerToken`,
  `McpCallerClient`) are structural; `@strav/oauth2`'s records satisfy them
- Auth is opt-in: with no `middleware`, the HTTP transport is unauthenticated
  exactly as before
