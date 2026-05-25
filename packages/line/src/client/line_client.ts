import { ExternalServiceError, ConfigurationError } from '@strav/kernel'
import { LINE_LIMITS } from '../types.ts'
import type { LineMessage, LineRecipient } from '../types.ts'

export interface LineClientConfig {
  channelAccessToken: string
  baseUrl?: string
  dataBaseUrl?: string
}

/**
 * Direct client for the LINE Messaging API.
 *
 * Exposes the full set of endpoints we use from the platform: push, reply,
 * multicast, broadcast, narrowcast, and the data-API content download
 * endpoint for inbound media (images sent by the user, voice notes, etc.).
 *
 * Unlike @strav/signal's LineTransport this client accepts the full
 * LineMessage union — including Flex Messages with quick replies, sender
 * overrides, and per-message emoji substitutions — and lets the caller
 * batch up to 5 messages per request (the LINE-enforced ceiling).
 *
 * Each request returns the raw provider response untouched. LINE does not
 * return per-message IDs on /push or /reply, but does on /broadcast (the
 * X-Line-Request-Id header) and inside the response body for some
 * endpoints; callers needing IDs should pull from `raw` themselves.
 */
export class LineClient {
  private readonly channelAccessToken: string
  private readonly baseUrl: string
  private readonly dataBaseUrl: string

  constructor(config: LineClientConfig) {
    if (!config.channelAccessToken) {
      throw new ConfigurationError('LineClient requires channelAccessToken')
    }
    this.channelAccessToken = config.channelAccessToken
    this.baseUrl = config.baseUrl ?? 'https://api.line.me'
    this.dataBaseUrl = config.dataBaseUrl ?? 'https://api-data.line.me'
  }

  /** Send up to 5 messages to a single recipient via /v2/bot/message/push. */
  async push(
    to: LineRecipient,
    messages: LineMessage | LineMessage[],
    options?: { notificationDisabled?: boolean; customAggregationUnits?: string[] }
  ): Promise<unknown> {
    const arr = this.normalize(messages)
    return this.callApi('/v2/bot/message/push', {
      to,
      messages: arr,
      notificationDisabled: options?.notificationDisabled,
      customAggregationUnits: options?.customAggregationUnits,
    })
  }

  /** Reply to an inbound message using its single-use reply token. */
  async reply(
    replyToken: string,
    messages: LineMessage | LineMessage[],
    options?: { notificationDisabled?: boolean }
  ): Promise<unknown> {
    if (!replyToken) {
      throw new ExternalServiceError('LINE', 400, 'reply requires a non-empty replyToken')
    }
    const arr = this.normalize(messages)
    return this.callApi('/v2/bot/message/reply', {
      replyToken,
      messages: arr,
      notificationDisabled: options?.notificationDisabled,
    })
  }

  /** Send the same messages to up to 500 recipients in one request. */
  async multicast(
    to: LineRecipient[],
    messages: LineMessage | LineMessage[],
    options?: { notificationDisabled?: boolean; customAggregationUnits?: string[] }
  ): Promise<unknown> {
    if (to.length === 0) {
      throw new ExternalServiceError('LINE', 400, 'multicast requires at least one recipient')
    }
    if (to.length > LINE_LIMITS.MULTICAST_RECIPIENTS) {
      throw new ExternalServiceError(
        'LINE',
        400,
        `multicast accepts at most ${LINE_LIMITS.MULTICAST_RECIPIENTS} recipients per request`
      )
    }
    const arr = this.normalize(messages)
    return this.callApi('/v2/bot/message/multicast', {
      to,
      messages: arr,
      notificationDisabled: options?.notificationDisabled,
      customAggregationUnits: options?.customAggregationUnits,
    })
  }

  /** Broadcast to every friend of the OA. Heavy fan-out; use with care. */
  async broadcast(
    messages: LineMessage | LineMessage[],
    options?: { notificationDisabled?: boolean }
  ): Promise<unknown> {
    const arr = this.normalize(messages)
    return this.callApi('/v2/bot/message/broadcast', {
      messages: arr,
      notificationDisabled: options?.notificationDisabled,
    })
  }

  /**
   * Download the binary content of an inbound message (image, video, audio,
   * file). Uses api-data.line.me — different host from the JSON API.
   *
   * Returns the raw bytes plus the Content-Type header so the caller can
   * forward to S3 / R2 with the right MIME type. LINE does not expose a
   * direct public URL for inbound media — this is the only way to fetch it.
   */
  async downloadContent(messageId: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    if (!messageId) {
      throw new ExternalServiceError('LINE', 400, 'downloadContent requires a messageId')
    }
    const url = `${this.dataBaseUrl}/v2/bot/message/${encodeURIComponent(messageId)}/content`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.channelAccessToken}` },
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new ExternalServiceError('LINE', response.status, text || 'content download failed')
    }
    const buffer = await response.arrayBuffer()
    return {
      bytes: new Uint8Array(buffer),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    }
  }

  /** Fetch the LINE profile of a user (display name, picture URL, status). */
  async getProfile(userId: string): Promise<{
    userId: string
    displayName: string
    pictureUrl?: string
    statusMessage?: string
    language?: string
  }> {
    if (!userId) {
      throw new ExternalServiceError('LINE', 400, 'getProfile requires a userId')
    }
    const url = `${this.baseUrl}/v2/bot/profile/${encodeURIComponent(userId)}`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.channelAccessToken}` },
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new ExternalServiceError('LINE', response.status, text || 'getProfile failed')
    }
    return (await response.json()) as {
      userId: string
      displayName: string
      pictureUrl?: string
      statusMessage?: string
      language?: string
    }
  }

  private normalize(messages: LineMessage | LineMessage[]): LineMessage[] {
    const arr = Array.isArray(messages) ? messages : [messages]
    if (arr.length === 0) {
      throw new ExternalServiceError('LINE', 400, 'at least one message is required')
    }
    if (arr.length > LINE_LIMITS.MESSAGES_PER_REQUEST) {
      throw new ExternalServiceError(
        'LINE',
        400,
        `LINE accepts at most ${LINE_LIMITS.MESSAGES_PER_REQUEST} messages per request`
      )
    }
    return arr
  }

  private async callApi(path: string, body: Record<string, unknown>): Promise<unknown> {
    const url = `${this.baseUrl}${path}`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.channelAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(stripUndefined(body)),
    })

    const text = await response.text()
    const raw: unknown = text ? safeJson(text) : undefined
    if (!response.ok) {
      throw new ExternalServiceError('LINE', response.status, formatError(raw) ?? text)
    }
    return raw
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out as T
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function formatError(raw: unknown): string | undefined {
  if (!raw) return undefined
  if (typeof raw === 'string') return raw
  if (typeof raw === 'object' && raw !== null) {
    const message = (raw as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  return JSON.stringify(raw)
}
