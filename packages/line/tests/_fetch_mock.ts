/**
 * Shared fetch-mock helpers for the @strav/line test suite.
 *
 * Mirrors the pattern used in @strav/signal's messaging_transports.test.ts —
 * each test installs a responder, captures every outgoing request, and
 * inspects URL / method / headers / body. Reset between tests so cross-test
 * pollution doesn't surface as flakes.
 */

export interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

export type Responder = (req: CapturedRequest) => Response | Promise<Response>

const originalFetch = globalThis.fetch
export const calls: CapturedRequest[] = []

export function installFetch(responder: Responder): void {
  globalThis.fetch = (async (...args: unknown[]) => {
    const [input, init] = args as [RequestInfo | URL, RequestInit?]
    const url = typeof input === 'string' ? input : input.toString()
    const method = init?.method ?? 'GET'
    const headers = headersToObject(init?.headers)
    let body: unknown = init?.body
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body)
      } catch {
        // leave as string
      }
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
