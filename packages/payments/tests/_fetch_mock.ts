/**
 * Shared fetch-mock helpers for the @strav/payments test suite.
 *
 * Mirrors the @strav/publish / @strav/line pattern: install a queue of
 * responders, capture every outgoing request, reset between tests.
 */

export interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

const originalFetch = globalThis.fetch
export const calls: CapturedRequest[] = []

export function installFetchQueue(responses: (Response | (() => Response))[]): void {
  let index = 0
  globalThis.fetch = (async (...args: unknown[]) => {
    const [input, init] = args as [RequestInfo | URL, RequestInit?]
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const headers = headersToObject(init?.headers)
    let body: unknown = init?.body
    if (body instanceof URLSearchParams) {
      body = Object.fromEntries(body.entries())
    } else if (typeof body === 'string') {
      body = parseBody(body, headers['content-type'])
    }
    calls.push({ url, method, headers, body })
    const next = responses[index++]
    if (!next) throw new Error(`Unexpected fetch call #${index} — queue exhausted`)
    return typeof next === 'function' ? next() : next
  }) as typeof fetch
}

export function installFetch(responder: (req: CapturedRequest) => Response): void {
  installFetchQueue([])
  // Replace the queue with a single repeating responder.
  globalThis.fetch = (async (...args: unknown[]) => {
    const [input, init] = args as [RequestInfo | URL, RequestInit?]
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const headers = headersToObject(init?.headers)
    let body: unknown = init?.body
    if (body instanceof URLSearchParams) {
      body = Object.fromEntries(body.entries())
    } else if (typeof body === 'string') {
      body = parseBody(body, headers['content-type'])
    }
    const captured: CapturedRequest = { url, method, headers, body }
    calls.push(captured)
    return responder(captured)
  }) as typeof fetch
}

export function restoreFetch(): void {
  globalThis.fetch = originalFetch
}

export function resetCalls(): void {
  calls.length = 0
}

function parseBody(text: string, contentType?: string): unknown {
  if (contentType?.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(text).entries())
  }
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function headersToObject(input: HeadersInit | undefined): Record<string, string> {
  if (!input) return {}
  if (input instanceof Headers) {
    const out: Record<string, string> = {}
    input.forEach((value, key) => {
      out[key.toLowerCase()] = value
    })
    return out
  }
  if (Array.isArray(input)) {
    return Object.fromEntries(input.map(([k, v]) => [k.toLowerCase(), v]))
  }
  return Object.fromEntries(
    Object.entries(input as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])
  )
}
