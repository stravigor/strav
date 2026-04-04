/**
 * Browser-safe route helpers that work without the server-side router instance.
 *
 * These functions maintain the same API as the server-side route helpers but
 * require route definitions to be provided at runtime or fallback to URL construction.
 */

export interface RouteOptions extends Omit<RequestInit, 'body'> {
  params?: Record<string, any>
  body?: any
}

// Global registry for client-side route definitions
const clientRoutes = new Map<string, { method: string; pattern: string }>()

/**
 * Register route definitions for client-side use.
 * This should be called during app initialization with route data from the server.
 */
export function registerRoutes(routes: Record<string, { method: string; pattern: string }>) {
  Object.entries(routes).forEach(([name, def]) => {
    clientRoutes.set(name, def)
  })
}

/**
 * Generate a URL for a named route with optional parameters.
 *
 * @example
 * const profileUrl = routeUrl('users.profile', { id: 456 })
 * // Returns '/users/456'
 */
export function routeUrl(name: string, params?: Record<string, any>): string {
  const routeDef = clientRoutes.get(name)
  if (!routeDef) {
    throw new Error(`Route '${name}' not found. Make sure to call registerRoutes() with route definitions.`)
  }

  return generateUrl(routeDef.pattern, params)
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
 */
export async function route(
  name: string,
  data?: any,
  options?: RouteOptions
): Promise<Response> {
  const routeDef = clientRoutes.get(name)
  if (!routeDef) {
    throw new Error(`Route '${name}' not found. Make sure to call registerRoutes() with route definitions.`)
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
  const generatedUrl = generateUrl(routeDef.pattern, opts.params)

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
 * Generate URL from pattern and parameters (browser-safe version)
 */
function generateUrl(pattern: string, params?: Record<string, any>): string {
  let url = pattern
  const queryParams: Record<string, string> = {}

  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      const paramPattern = `:${key}`
      const wildcardPattern = `*${key}`

      if (url.includes(paramPattern)) {
        // Replace route parameter
        url = url.replace(paramPattern, encodeURIComponent(String(value)))
      } else if (url.includes(wildcardPattern)) {
        // Replace wildcard parameter
        url = url.replace(`/${wildcardPattern}`, `/${encodeURIComponent(String(value))}`)
      } else {
        // Add as query parameter
        queryParams[key] = String(value)
      }
    })
  }

  // Append query parameters
  const queryString = Object.keys(queryParams)
    .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(queryParams[key] ?? '')}`)
    .join('&')

  if (queryString) {
    url += (url.includes('?') ? '&' : '?') + queryString
  }

  return url
}