import { app } from '@strav/kernel/core/application'
import Router from './router.ts'

export { default as Context } from './context.ts'
export { default as Router } from './router.ts'
export { default as Server } from './server.ts'
export { compose } from './middleware.ts'
export { serializeCookie, parseCookies, withCookie, clearCookie } from './cookie.ts'
export { rateLimit, MemoryStore } from './rate_limit.ts'
export {
  idempotency,
  MemoryIdempotencyStore,
  DatabaseIdempotencyStore,
} from './idempotency.ts'
export { Resource } from './resource.ts'
export { route, routeUrl, routeFullUrl } from './route_helper.ts'
export type { Handler, Middleware, Next } from './middleware.ts'
export type { GroupOptions, WebSocketHandlers, WebSocketData, RouteDefinition } from './router.ts'
export type { CookieOptions } from './cookie.ts'
export type { CorsOptions } from './cors.ts'
export type { RateLimitOptions, RateLimitStore, RateLimitInfo } from './rate_limit.ts'
export type {
  IdempotencyOptions,
  IdempotencyStore,
  IdempotencyRecord,
  CapturedResponse,
} from './idempotency.ts'
export type { RouteOptions } from './route_helper.ts'

if (!app.has(Router)) app.singleton(Router)
export const router = app.resolve(Router)
