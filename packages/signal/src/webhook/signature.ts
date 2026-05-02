import { createHmac, timingSafeEqual } from 'node:crypto'
import type { SignedHeaders } from './types.ts'

/**
 * Sign a webhook request and produce the headers that subscribers should
 * verify. Body is the exact JSON string sent over the wire — recompute the
 * HMAC over the same bytes when verifying on the receiver side.
 *
 * The signed string is `timestamp + "." + body` to bind both. Stripe / GitHub
 * use the same scheme.
 */
export function signRequest(
  secret: string,
  event: string,
  deliveryId: string,
  body: string,
  now: Date = new Date()
): SignedHeaders {
  const timestamp = String(Math.floor(now.getTime() / 1000))
  const signature = 'sha256=' + createHmac('sha256', secret)
    .update(timestamp + '.' + body)
    .digest('hex')
  return {
    'X-Strav-Delivery': deliveryId,
    'X-Strav-Event': event,
    'X-Strav-Timestamp': timestamp,
    'X-Strav-Signature': signature,
    'Content-Type': 'application/json',
    'User-Agent': 'strav-webhooks/1',
  }
}

/**
 * Verify a `X-Strav-Signature` header against a body and secret. Subscribers
 * use this on the receive side. Constant-time compare; tolerates the
 * `sha256=` prefix being absent.
 *
 * `maxAgeSeconds` rejects timestamps too far in the past — defaults to 5
 * minutes to bound replay windows.
 */
export function verifySignature(opts: {
  secret: string
  body: string
  timestamp: string
  signature: string
  maxAgeSeconds?: number
  now?: Date
}): boolean {
  const maxAge = opts.maxAgeSeconds ?? 300
  const now = opts.now ?? new Date()
  const ts = Number(opts.timestamp)
  if (!Number.isFinite(ts)) return false
  const skew = Math.abs(Math.floor(now.getTime() / 1000) - ts)
  if (skew > maxAge) return false

  const provided = opts.signature.startsWith('sha256=')
    ? opts.signature.slice('sha256='.length)
    : opts.signature
  const expected = createHmac('sha256', opts.secret)
    .update(opts.timestamp + '.' + opts.body)
    .digest('hex')

  if (expected.length !== provided.length) return false
  return timingSafeEqual(Buffer.from(expected, 'utf-8'), Buffer.from(provided, 'utf-8'))
}
