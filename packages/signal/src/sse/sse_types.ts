import type { Context, Middleware } from '@strav/http'

// ---------------------------------------------------------------------------
// Core SSE Types
// ---------------------------------------------------------------------------

/** Server-Sent Event structure */
export interface SSEEvent {
  /** Event type/name */
  event?: string
  /** Event data (will be JSON stringified if object) */
  data: string | object
  /** Event ID for client-side last-event-id */
  id?: string
  /** Retry hint in milliseconds */
  retry?: number
}

/** Raw SSE message format for parsing */
export interface RawSSEMessage {
  event?: string
  data: string
  id?: string
  retry?: string
}

// ---------------------------------------------------------------------------
// Server-Side Types
// ---------------------------------------------------------------------------

/** Authorization callback for SSE channels */
export type SSEAuthorizeCallback = (
  ctx: Context,
  params: Record<string, string>
) => boolean | Promise<boolean>

/** SSE channel configuration */
export interface SSEChannelConfig {
  /** Authorization callback */
  authorize?: SSEAuthorizeCallback
  /** Heartbeat interval in ms (0 to disable) */
  heartbeat?: number
  /** Custom headers for SSE response */
  headers?: Record<string, string>
}

/** Options for booting SSE endpoint */
export interface SSEBootOptions {
  /** SSE endpoint path (default: /_sse) */
  path?: string
  /** Middleware to run on SSE connections */
  middleware?: Middleware[]
  /** Default heartbeat interval in ms (default: 30000) */
  defaultHeartbeat?: number
  /** CORS origins (default: *) */
  cors?: string | string[]
}

/** SSE client connection */
export interface SSEConnection {
  /** Client ID */
  id: string
  /** Active channel subscriptions */
  channels: Set<string>
  /** Response writer */
  writer: WritableStreamDefaultWriter
  /** Context from initial connection */
  context: Context
  /** Last activity timestamp */
  lastActivity: number
  /** Heartbeat timer */
  heartbeatTimer?: ReturnType<typeof setInterval>
}

/** Channel definition with pattern matching */
export interface SSEChannelDefinition {
  /** Original pattern (e.g., "users/:id") */
  pattern: string
  /** Compiled regex for matching */
  regex: RegExp
  /** Parameter names extracted from pattern */
  paramNames: string[]
  /** Channel configuration */
  config: SSEChannelConfig
}

// ---------------------------------------------------------------------------
// Client-Side Types
// ---------------------------------------------------------------------------

/** Options for SSE client */
export interface SSEClientOptions {
  /** SSE endpoint URL (auto-detected if not provided) */
  url?: string
  /** Request credentials mode */
  withCredentials?: boolean
  /** Custom headers */
  headers?: Record<string, string>
  /** Initial reconnect delay in ms (default: 1000) */
  reconnectDelay?: number
  /** Max reconnect delay in ms (default: 30000) */
  maxReconnectDelay?: number
  /** Max reconnect attempts (default: Infinity) */
  maxReconnectAttempts?: number
  /** Reconnect delay multiplier (default: 1.5) */
  reconnectMultiplier?: number
}

/** SSE subscription event listener */
export type SSEEventListener<T = any> = (data: T) => void

/** SSE connection state */
export const SSEState = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSED: 2,
} as const

export type SSEStateType = typeof SSEState[keyof typeof SSEState]

/** Subscription to an SSE channel */
export interface SSESubscription {
  /** Channel name */
  channel: string
  /** Add event listener */
  on<T = any>(event: string, listener: SSEEventListener<T>): () => void
  /** Remove event listener */
  off(event: string, listener: SSEEventListener): void
  /** Close subscription */
  close(): void
}

// ---------------------------------------------------------------------------
// Utility Types
// ---------------------------------------------------------------------------

/** SSE stream options for creating transform streams */
export interface SSEStreamOptions {
  /** Include comment for keepalive */
  includeComments?: boolean
  /** Comment interval in ms */
  commentInterval?: number
}

/** Parsed SSE field from raw stream */
export interface SSEField {
  name: string
  value: string
}