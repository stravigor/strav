import type { z } from 'zod'
import type { Application } from '@strav/kernel'
import type {
  CallToolResult,
  GetPromptResult,
  ReadResourceResult,
  RequestId,
} from '@modelcontextprotocol/sdk/types.js'
import type { ElicitFn } from './elicitation.ts'

// Re-export SDK result types for user convenience
export type { CallToolResult, GetPromptResult, ReadResourceResult }

// ── Configuration ────────────────────────────────────────────────────

export interface McpConfig {
  /** Server name shown to AI clients. Defaults to app name. */
  name: string
  /** Server version. */
  version: string
  /** Path to a file that registers tools/resources/prompts (for CLI). */
  register?: string
  /** HTTP transport settings. */
  http: {
    /** Whether to enable HTTP transport. */
    enabled: boolean
    /** Mount path for the MCP endpoint. */
    path: string
  }
}

// ── Caller identity ──────────────────────────────────────────────────

/**
 * A validated caller token, surfaced to handlers when an auth middleware
 * (e.g. `oauth()` from `@strav/oauth2`) ran on the MCP HTTP transport.
 *
 * Structural by design — `@strav/mcp` stays auth-agnostic. `@strav/oauth2`'s
 * `OAuthTokenData` is assignable to this shape.
 */
export interface McpCallerToken {
  /** The token record id. */
  id: string
  /** The OAuth client this token was issued to. */
  clientId: string
  /** The user the token is bound to, or `null` for machine (client_credentials) tokens. */
  userId: string | null
  /** Scopes granted to this token. */
  scopes: string[]
  /** When the token expires. */
  expiresAt: Date
}

/**
 * The OAuth client behind an authenticated MCP call. Structural — assignable
 * from `@strav/oauth2`'s `OAuthClientData`.
 */
export interface McpCallerClient {
  /** The client id. */
  id: string
  /** Human-readable client name. */
  name: string
  /** Scopes the client may request; `null` means unrestricted. */
  scopes: string[] | null
  /** Whether this is a confidential (machine) client. */
  confidential: boolean
}

/** Per-request transport metadata, forwarded from the MCP SDK. */
export interface McpRequestInfo {
  /** The Streamable-HTTP session id, when the transport is stateful. */
  sessionId?: string
  /** The JSON-RPC id of the call being handled. */
  requestId?: RequestId
  /** Aborts when the caller cancels the request. */
  signal?: AbortSignal
}

// ── Handler Context ──────────────────────────────────────────────────

export interface ToolHandlerContext {
  /** The Application container — resolve any service via DI. */
  app: Application
  /**
   * The validated caller token — present only when an auth middleware ran on
   * the HTTP transport. `undefined` for stdio and unauthenticated HTTP.
   */
  oauth_token?: McpCallerToken
  /** The calling OAuth client. `undefined` when no auth middleware ran. */
  oauth_client?: McpCallerClient
  /** The resolved user, for user-bound tokens only. */
  user?: unknown
  /** Per-request transport metadata (session id, request id, abort signal). */
  request?: McpRequestInfo
  /**
   * Request input or a confirmation from a human, mid-call (MCP Elicitation).
   * Present when the transport has a server→client channel and the client
   * advertised the `elicitation` capability. See `confirmation()` / `wasApproved()`.
   */
  elicit?: ElicitFn
}

// ── Tool ─────────────────────────────────────────────────────────────

/** Raw Zod shape: `{ id: z.number(), name: z.string() }`. */
export type ZodRawShape = Record<string, z.ZodTypeAny>

/** Infer the output type from a Zod raw shape. */
export type InferShape<T extends ZodRawShape> = { [K in keyof T]: z.infer<T[K]> }

export interface ToolRegistration<TShape extends ZodRawShape = ZodRawShape> {
  name: string
  description?: string
  input?: TShape
  handler: ToolHandler<TShape>
}

export type ToolHandler<TShape extends ZodRawShape = ZodRawShape> = (
  params: InferShape<TShape>,
  ctx: ToolHandlerContext
) => CallToolResult | Promise<CallToolResult>

// ── Resource ─────────────────────────────────────────────────────────

export interface ResourceRegistration {
  /** URI or URI template, e.g., `'file:///config'` or `'strav://models/{name}'`. */
  uri: string
  name?: string
  description?: string
  mimeType?: string
  handler: ResourceHandler
}

export type ResourceHandler = (
  uri: URL,
  params: Record<string, string>,
  ctx: ToolHandlerContext
) => ReadResourceResult | Promise<ReadResourceResult>

// ── Prompt ───────────────────────────────────────────────────────────

export interface PromptRegistration<TShape extends ZodRawShape = ZodRawShape> {
  name: string
  description?: string
  args?: TShape
  handler: PromptHandler<TShape>
}

export type PromptHandler<TShape extends ZodRawShape = ZodRawShape> = (
  args: InferShape<TShape>,
  ctx: ToolHandlerContext
) => GetPromptResult | Promise<GetPromptResult>
