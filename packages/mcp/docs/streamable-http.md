# Streamable HTTP transport

`mountHttpTransport(router, options?)` exposes the MCP server over the
[MCP **Streamable HTTP** transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http).
It is implemented by the official SDK's `WebStandardStreamableHTTPServerTransport`,
which `@strav/mcp` mounts on three routes at the configured path (default `/mcp`):

| Method | Purpose |
|--------|---------|
| `POST /mcp`   | Client → server JSON-RPC requests and notifications. |
| `GET /mcp`    | Opens the server → client SSE stream. |
| `DELETE /mcp` | Terminates the session. |

## Sessions (`Mcp-Session-Id`)

The transport runs in **stateful** mode — `mountHttpTransport` always supplies a
`sessionIdGenerator` (`crypto.randomUUID()`).

- The `initialize` response carries a `Mcp-Session-Id` header.
- Every subsequent request **must** echo that header back.
- A request with an **unknown / expired** session id is rejected `404 Not Found`.
- A non-`initialize` request with **no** session id is rejected `400 Bad Request`.
- `DELETE /mcp` with the session id ends the session.

A hosted gateway therefore serves many concurrent sessions off the single
mounted transport; the session id is the client's handle to its message stream.

## Protocol version

The transport validates the `MCP-Protocol-Version` header. During `initialize`,
version negotiation handles unknown versions gracefully (the server answers with
a version it supports). On later requests an unsupported version is rejected
`400`; a missing header defaults to the version negotiated at initialization.

## Server → server streaming (SSE)

`GET /mcp` opens a `text/event-stream`. Server-initiated messages — progress
notifications, [elicitation](./elicitation) requests, task updates — are
delivered on this stream.

## Resumability (`Last-Event-ID`)

Resumability is **opt-in**. Pass an `EventStore` to enable it:

```typescript
import { mountHttpTransport, MemoryEventStore } from '@strav/mcp'

mountHttpTransport(router, {
  middleware: [oauth(), scopes('mcp')],
  eventStore: new MemoryEventStore(),
})
```

With an `EventStore` configured:

- Every server → client message on an SSE stream is assigned an `id`.
- A client whose connection drops reconnects with the `Last-Event-ID` header.
- The transport calls `EventStore.replayEventsAfter(lastEventId, …)` and replays
  every message recorded after that id on the same stream — no messages lost.

`MemoryEventStore` is a single-node reference implementation that keeps events
in process memory. **A multi-node deployment must supply an `EventStore` backed
by shared storage** (e.g. Redis Streams) so a client can resume against
whichever node it reconnects to. The `EventStore` interface to implement:

```typescript
interface EventStore {
  storeEvent(streamId: string, message: JSONRPCMessage): Promise<string>
  getStreamIdForEventId?(eventId: string): Promise<string | undefined>
  replayEventsAfter(
    lastEventId: string,
    opts: { send: (eventId: string, message: JSONRPCMessage) => Promise<void> },
  ): Promise<string>
}
```

## Authentication

`options.middleware` runs on every POST/GET/DELETE before the transport — an
unauthenticated or insufficient-scope call is rejected (401 / 403) before any
handler runs, and the resolved caller identity reaches handlers via
`ToolHandlerContext`. See the package README and `@strav/oauth2`.
