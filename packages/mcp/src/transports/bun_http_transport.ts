import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { EventStore } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js'
import { compose } from '@strav/http'
import type { Router, Context, Middleware } from '@strav/http'
import { Emitter } from '@strav/kernel'
import McpManager from '../mcp_manager.ts'
import type { McpCallerToken } from '../types.ts'

export type { WebStandardStreamableHTTPServerTransport, EventStore }

/** Options for {@link mountHttpTransport}. */
export interface MountHttpOptions {
  /**
   * Middleware to run on every MCP HTTP request, before the transport.
   * An unauthenticated / insufficient-scope call is rejected by the
   * middleware's response (e.g. 401 / 403) **before any handler runs**.
   *
   * @example
   * mountHttpTransport(router, { middleware: [oauth(), scopes('mcp')] })
   */
  middleware?: Middleware[]
  /**
   * Event store enabling Streamable-HTTP resumability. When provided,
   * clients may reconnect with `Last-Event-ID` and replay missed messages.
   */
  eventStore?: EventStore
}

/**
 * Translate the caller identity an auth middleware left on the HTTP `Context`
 * into the SDK's `AuthInfo`, so it reaches tool / resource / prompt handlers
 * via `ToolHandlerContext`. Returns `undefined` when the call is unauthenticated.
 *
 * The full token / client / user records ride in `AuthInfo.extra` — a typed
 * `Record<string, unknown>` made for exactly this — and `McpManager.buildContext`
 * reads them back out on the handler side.
 */
function toAuthInfo(ctx: Context): AuthInfo | undefined {
  const token = ctx.get<McpCallerToken | undefined>('oauth_token')
  if (!token) return undefined

  const bearer = ctx.header('authorization')?.slice(7) || token.id

  return {
    token: bearer,
    clientId: token.clientId,
    scopes: token.scopes ?? [],
    expiresAt:
      token.expiresAt instanceof Date
        ? Math.floor(token.expiresAt.getTime() / 1000)
        : undefined,
    extra: {
      oauth_token: token,
      oauth_client: ctx.get('oauth_client'),
      user: ctx.get('user'),
    },
  }
}

/**
 * Mount the MCP server on a Strav router via Streamable HTTP.
 *
 * Uses the SDK's `WebStandardStreamableHTTPServerTransport` which works
 * natively with Bun's Web Standard Request/Response API.
 *
 * Registers handlers at the configured path (default: `/mcp`) for
 * POST (requests), GET (SSE), and DELETE (session termination).
 *
 * Pass `options.middleware` to authenticate and scope every call — see
 * {@link MountHttpOptions}. With no options the endpoint is unauthenticated,
 * exactly as before.
 */
export function mountHttpTransport(
  router: Router,
  options?: MountHttpOptions
): WebStandardStreamableHTTPServerTransport {
  const path = McpManager.config.http.path
  const middleware = options?.middleware ?? []

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    eventStore: options?.eventStore,
  })

  const server = McpManager.getServer()
  server.connect(transport)

  // The SDK transport handles POST/GET/DELETE routing internally
  // via handleRequest(req, options): Promise<Response>.
  const handler = async (ctx: Context): Promise<Response> => {
    let authInfo: AuthInfo | undefined

    if (middleware.length > 0) {
      // Mirror @strav/signal's SSEManager: run the middleware pipeline and
      // bail out with its response if anything rejected (401 / 403 / …).
      const composed = compose(middleware, async () => new Response('', { status: 200 }))
      const rejection = await composed(ctx)
      if (rejection.status !== 200) return rejection
      authInfo = toAuthInfo(ctx)
    }

    const response = await transport.handleRequest(
      ctx.request,
      authInfo ? { authInfo } : undefined
    )
    await Emitter.emit('mcp:http-request', { method: ctx.method, path })
    return response
  }

  router.post(path, handler)
  router.get(path, handler)
  router.delete(path, handler)

  Emitter.emit('mcp:http-mounted', { path })

  return transport
}
