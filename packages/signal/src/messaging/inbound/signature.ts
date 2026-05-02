import { createHmac, timingSafeEqual } from 'node:crypto'
import { AuthenticationError } from '@strav/kernel'

/**
 * Verify a Meta `X-Hub-Signature-256` header against the raw request body.
 *
 * Format: `sha256=<hex>` where the HMAC is computed over the exact bytes
 * Meta delivered. Any reformatting of the body (re-stringifying JSON,
 * re-encoding form data) breaks verification — handle the request before
 * the framework parses it.
 *
 * @see https://developers.facebook.com/docs/graph-api/webhooks/getting-started#verification-requests
 */
export function verifyXHubSignature256(
  service: 'WhatsApp' | 'Messenger',
  rawBody: Buffer,
  header: string | undefined,
  appSecret: string
): void {
  if (!header) {
    throw new AuthenticationError(`${service} webhook missing X-Hub-Signature-256`)
  }
  if (!header.startsWith('sha256=')) {
    throw new AuthenticationError(`${service} webhook signature must use sha256= prefix`)
  }
  const provided = header.slice('sha256='.length)
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex')

  if (expected.length !== provided.length) {
    throw new AuthenticationError(`${service} webhook signature mismatch`)
  }
  const ok = timingSafeEqual(
    Buffer.from(expected, 'utf-8'),
    Buffer.from(provided, 'utf-8')
  )
  if (!ok) throw new AuthenticationError(`${service} webhook signature mismatch`)
}

/**
 * Verify a LINE `X-Line-Signature` header.
 *
 * Format: base64(HMAC-SHA256(channelSecret, rawBody)). The header carries no
 * algorithm prefix and is plain base64.
 *
 * @see https://developers.line.biz/en/reference/messaging-api/#signature-validation
 */
export function verifyLineSignature(
  rawBody: Buffer,
  header: string | undefined,
  channelSecret: string
): void {
  if (!header) {
    throw new AuthenticationError('LINE webhook missing X-Line-Signature')
  }
  const expected = createHmac('sha256', channelSecret).update(rawBody).digest('base64')

  if (expected.length !== header.length) {
    throw new AuthenticationError('LINE webhook signature mismatch')
  }
  const ok = timingSafeEqual(
    Buffer.from(expected, 'utf-8'),
    Buffer.from(header, 'utf-8')
  )
  if (!ok) throw new AuthenticationError('LINE webhook signature mismatch')
}

/** Coerce InboundWebhookInput.body into a Buffer for signature verification. */
export function toBuffer(body: string | Buffer): Buffer {
  return typeof body === 'string' ? Buffer.from(body, 'utf-8') : body
}
