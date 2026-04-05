import { router } from './index.ts'
import type { RouteDefinition } from './router.ts'
import { app } from '@strav/kernel/core/application'
import Configuration from '@strav/kernel/config/configuration'

export interface RouteOptions extends Omit<RequestInit, 'body'> {
  params?: Record<string, any>
  body?: any
}

/**
 * Invoke a named route with automatic method detection and smart defaults.
 *
 * @example
 * // Simple POST with JSON body
 * await route('auth.register', {
 *   name: 'John',
 *   email: 'john@example.com',
 *   password: 'secret'
 * })
 *
 * // GET with URL parameters
 * await route('users.show', { params: { id: 123 } })
 *
 * // Custom headers and options
 * await route('api.upload', {
 *   body: formData,
 *   headers: { 'X-Custom-Header': 'value' }
 * })
 *
 * // Override detected method
 * await route('users.index', { method: 'HEAD' })
 */
export async function route(
  name: string,
  data?: any,
  options?: RouteOptions
): Promise<Response> {
  const routeDef = router.getRouteByName(name)
  if (!routeDef) {
    throw new Error(`Route '${name}' not found`)
  }

  // Determine if data is the body or options
  let body: any
  let opts: RouteOptions = {}

  if (data !== undefined) {
    // If data has params, body, or any RequestInit properties, treat it as options
    if (
      typeof data === 'object' &&
      !Array.isArray(data) &&
      !(data instanceof FormData) &&
      !(data instanceof Blob) &&
      !(data instanceof ArrayBuffer) &&
      !(data instanceof URLSearchParams) &&
      ('params' in data || 'body' in data || 'headers' in data || 'cache' in data ||
       'credentials' in data || 'mode' in data || 'redirect' in data || 'referrer' in data)
    ) {
      opts = data
      body = opts.body
    } else {
      // Otherwise, treat data as the body
      body = data
      opts = options || {}
    }
  } else {
    opts = options || {}
  }

  // Generate URL with parameters
  const generatedUrl = router.generateUrl(name, opts.params)

  // Determine method from route definition
  const method = opts.method || routeDef.method

  // Build headers with smart defaults
  const headers = new Headers(opts.headers)

  // Set default Accept header if not provided
  if (!headers.has('Accept')) {
    headers.set('Accept', 'application/json')
  }

  // Handle body and Content-Type
  let requestBody: string | FormData | Blob | ArrayBuffer | URLSearchParams | undefined
  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    if (body instanceof FormData || body instanceof Blob || body instanceof ArrayBuffer || body instanceof URLSearchParams) {
      // Let fetch set the Content-Type for FormData, or use the existing type for Blob/ArrayBuffer
      requestBody = body
    } else if (typeof body === 'object') {
      // JSON body
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json')
      }
      requestBody = JSON.stringify(body)
    } else {
      // String or other primitive
      requestBody = String(body)
      if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'text/plain')
      }
    }
  }

  // Set default credentials if not provided
  const credentials = opts.credentials || 'same-origin'

  // Build final fetch options
  const fetchOptions: RequestInit = {
    ...opts,
    method,
    headers,
    credentials,
    ...(requestBody !== undefined && { body: requestBody })
  }

  // Remove our custom properties
  delete (fetchOptions as any).params

  return fetch(generatedUrl, fetchOptions)
}

/**
 * Generate a URL for a named route with optional parameters.
 *
 * @example
 * const profileUrl = routeUrl('users.profile', { id: 456 })
 * // Returns '/users/456'
 *
 * const searchUrl = routeUrl('api.search', { q: 'test', page: 2 })
 * // Returns '/api/search?q=test&page=2'
 */
export function routeUrl(name: string, params?: Record<string, any>): string {
  return router.generateUrl(name, params)
}

/**
 * Generate a full URL (with protocol and domain) for a named route.
 *
 * Uses the APP_URL from configuration if set, otherwise constructs from
 * the current request context (requires passing the context).
 *
 * @example
 * // With APP_URL configured
 * const resetUrl = routeFullUrl('auth.password.reset', { token: 'abc123' })
 * // Returns 'https://example.com/auth/password-reset?token=abc123'
 *
 * // With request context
 * const profileUrl = routeFullUrl('users.profile', { id: 456 }, ctx)
 * // Returns 'https://example.com/users/456'
 *
 * // Override the base URL
 * const apiUrl = routeFullUrl('api.users', {}, null, 'https://api.example.com')
 * // Returns 'https://api.example.com/api/users'
 */
export function routeFullUrl(
  name: string,
  params?: Record<string, any>,
  context?: { getOrigin(): string } | null,
  baseUrl?: string
): string {
  const path = routeUrl(name, params)

  // Use provided base URL if given
  if (baseUrl) {
    return baseUrl.replace(/\/$/, '') + path
  }

  // Try to get app_url from config
  const config = app.resolve(Configuration)
  const appUrl = config.get('http.app_url') as string | undefined

  if (appUrl) {
    return appUrl.replace(/\/$/, '') + path
  }

  // Fall back to context origin
  if (context) {
    return context.getOrigin() + path
  }

  // If no context and no config, construct from http config
  const protocol = config.get('http.secure', false) ? 'https' : 'http'
  const domain = config.get('http.domain', 'localhost') as string
  const port = config.get('http.port', 3000) as number

  // Only include port if non-standard
  const includePort = (protocol === 'http' && port !== 80) ||
                      (protocol === 'https' && port !== 443)
  const host = includePort ? `${domain}:${port}` : domain

  return `${protocol}://${host}${path}`
}