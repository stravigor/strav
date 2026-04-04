/**
 * Browser-safe HTTP utilities from @strav/http
 *
 * This module exports only browser-compatible functionality,
 * avoiding Node.js dependencies that cause bundling issues.
 *
 * @example
 * ```typescript
 * import { route, routeUrl } from '@strav/http/client'
 *
 * // Use route helpers on the client-side
 * const response = await route('users.show', { params: { id: 123 } })
 * const profileUrl = routeUrl('users.profile', { id: 456 })
 * ```
 */

// Re-export browser-safe route helpers (no Node.js dependencies)
export { route, routeUrl, registerRoutes } from './route_helper.ts'
export type { RouteOptions } from './route_helper.ts'

// Re-export browser-safe types
export type {
  Handler,
  Middleware,
  Next
} from '../http/middleware.ts'

export type {
  CorsOptions
} from '../http/cors.ts'

export type {
  CookieOptions
} from '../http/cookie.ts'

export type {
  RouteDefinition,
  GroupOptions,
  WebSocketHandlers,
  WebSocketData
} from '../http/router.ts'