/**
 * Shared fetch-mock helpers for the @strav/publish test suite.
 *
 * Same pattern as @strav/line — installs a responder, captures every
 * outgoing request, resets between tests. Most adapter tests use the
 * single-shot helper; multi-step flows (Instagram's container+publish,
 * WordPress's media upload + post) use a queue-style responder so each
 * call gets its own response.
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
    if (body instanceof URLSearchParams) {
      body = Object.fromEntries(body.entries())
    } else if (typeof body === 'string') {
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

/**
 * Install a queue of responses — each fetch consumes the next entry,
 * throws if the queue is empty.
 */
export function installFetchQueue(responses: (Response | (() => Response))[]): void {
  let index = 0
  installFetch(() => {
    const entry = responses[index++]
    if (!entry) throw new Error(`Unexpected fetch call #${index} — queue exhausted`)
    return typeof entry === 'function' ? entry() : entry
  })
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
