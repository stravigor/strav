/**
 * Browser-safe exports from @strav/view
 *
 * This module contains only client-side functionality that can be safely
 * bundled for the browser without pulling in Node.js dependencies.
 */

// Re-export only browser-safe route helpers
export { route, routeUrl, registerRoutes } from './route_helper.ts'
export type { RouteOptions } from './route_helper.ts'

// Re-export client-side router (SPA router)
export * from './router.ts'