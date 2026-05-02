import { signRequest } from './signature.ts'
import type { WebhookConfig, WebhookDelivery, WebhookEndpoint } from './types.ts'

export interface AttemptOutcome {
  ok: boolean
  status?: number
  responseBody?: string
  error?: string
}

/**
 * Perform a single delivery attempt. Signs the request, fetches the endpoint
 * URL, captures the response, and returns a result object the caller uses to
 * decide retry vs done. The caller (manager) updates the delivery record.
 *
 * Network errors and non-2xx responses are returned as `{ ok: false }` —
 * exceptions only escape for unexpected programming errors.
 */
export async function attemptDelivery(
  endpoint: WebhookEndpoint,
  delivery: WebhookDelivery,
  cfg: WebhookConfig
): Promise<AttemptOutcome> {
  const body = JSON.stringify(delivery.payload)
  const headers = signRequest(endpoint.secret, delivery.event, delivery.id, body)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), cfg.fetchTimeoutMs)
  try {
    const response = await fetch(endpoint.url, {
      method: 'POST',
      headers: headers as unknown as Record<string, string>,
      body,
      signal: controller.signal,
    })
    const raw = await readResponseBody(response, cfg.responseBodyLimit)
    if (!response.ok) {
      return { ok: false, status: response.status, responseBody: raw, error: `HTTP ${response.status}` }
    }
    return { ok: true, status: response.status, responseBody: raw }
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  } finally {
    clearTimeout(timer)
  }
}

async function readResponseBody(response: Response, limit: number): Promise<string> {
  try {
    const text = await response.text()
    if (text.length <= limit) return text
    return text.slice(0, limit)
  } catch {
    return ''
  }
}
