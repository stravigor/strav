import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ExternalServiceError } from '@strav/kernel'
import { WhatsAppTransport } from '../src/messaging/transports/whatsapp_transport.ts'
import { MessengerTransport } from '../src/messaging/transports/messenger_transport.ts'
import { LineTransport } from '../src/messaging/transports/line_transport.ts'

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: unknown
}

const originalFetch = globalThis.fetch
let calls: CapturedRequest[] = []

type Responder = (req: CapturedRequest) => Response | Promise<Response>

function installFetch(responder: Responder): void {
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

beforeEach(() => {
  calls = []
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('WhatsAppTransport', () => {
  const config = {
    phoneNumberId: 'PNID',
    accessToken: 'AT',
    baseUrl: 'https://graph.test/v20.0',
  }

  test('posts a text message with bearer auth and reply context', async () => {
    installFetch(() => Response.json({ messages: [{ id: 'wamid.NEW' }] }))
    const t = new WhatsAppTransport(config)

    const result = await t.send({ to: '15551112222', text: 'hi', replyTo: 'wamid.PARENT' })

    expect(result.providerMessageId).toBe('wamid.NEW')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://graph.test/v20.0/PNID/messages')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers['authorization']).toBe('Bearer AT')
    expect(calls[0]!.body).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '15551112222',
      type: 'text',
      text: { body: 'hi', preview_url: false },
      context: { message_id: 'wamid.PARENT' },
    })
  })

  test('sends text and each media item as separate calls', async () => {
    installFetch((req: CapturedRequest) => {
      const body = req.body as Record<string, unknown>
      const id = `wamid.${body.type as string}`
      return Response.json({ messages: [{ id }] })
    })
    const t = new WhatsAppTransport(config)

    await t.send({
      to: '15551112222',
      text: 'caption',
      media: [
        { kind: 'image', url: 'https://cdn/x.jpg', caption: 'pic' },
        { kind: 'file', mediaId: 'M2', filename: 'doc.pdf' },
      ],
    })

    expect(calls).toHaveLength(3)
    expect((calls[1]!.body as Record<string, unknown>).type).toBe('image')
    expect((calls[1]!.body as Record<string, unknown>).image).toEqual({
      link: 'https://cdn/x.jpg',
      caption: 'pic',
    })
    expect((calls[2]!.body as Record<string, unknown>).type).toBe('document')
    expect((calls[2]!.body as Record<string, unknown>).document).toEqual({
      id: 'M2',
      filename: 'doc.pdf',
    })
  })

  test('throws ExternalServiceError on non-2xx', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ error: { message: 'invalid recipient' } }), {
          status: 400,
        })
    )
    const t = new WhatsAppTransport(config)
    await expect(t.send({ to: '15551112222', text: 'hi' })).rejects.toBeInstanceOf(
      ExternalServiceError
    )
  })

  test('rejects empty messages', async () => {
    const t = new WhatsAppTransport(config)
    await expect(t.send({ to: '15551112222' })).rejects.toBeInstanceOf(ExternalServiceError)
  })
})

describe('MessengerTransport', () => {
  const config = {
    pageAccessToken: 'PAGE_TOKEN',
    baseUrl: 'https://graph.test/v20.0',
  }

  test('posts text via /me/messages with access_token in query', async () => {
    installFetch(() => Response.json({ recipient_id: 'PSID', message_id: 'mid.A' }))
    const t = new MessengerTransport(config)

    const result = await t.send({ to: 'PSID', text: 'hello' })

    expect(result.providerMessageId).toBe('mid.A')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://graph.test/v20.0/me/messages?access_token=PAGE_TOKEN')
    expect(calls[0]!.body).toEqual({
      recipient: { id: 'PSID' },
      messaging_type: 'RESPONSE',
      message: { text: 'hello' },
    })
  })

  test('sends attachments with type+payload', async () => {
    installFetch(() => Response.json({ message_id: 'mid.B' }))
    const t = new MessengerTransport(config)
    await t.send({
      to: 'PSID',
      media: [{ kind: 'image', url: 'https://cdn/x.jpg' }],
    })

    expect(calls).toHaveLength(1)
    const body = calls[0]!.body as Record<string, unknown>
    expect((body.message as Record<string, unknown>).attachment).toEqual({
      type: 'image',
      payload: { is_reusable: false, url: 'https://cdn/x.jpg' },
    })
  })
})

describe('LineTransport', () => {
  const config = {
    channelAccessToken: 'CAT',
    baseUrl: 'https://api.line.test',
  }

  test('uses /push and bundles text + image into messages array', async () => {
    installFetch(() => new Response('{}', { status: 200 }))
    const t = new LineTransport(config)
    await t.send({
      to: 'U1',
      text: 'hi',
      media: [{ kind: 'image', url: 'https://cdn/x.jpg' }],
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.line.test/v2/bot/message/push')
    expect(calls[0]!.headers['authorization']).toBe('Bearer CAT')
    expect(calls[0]!.body).toEqual({
      to: 'U1',
      messages: [
        { type: 'text', text: 'hi' },
        {
          type: 'image',
          originalContentUrl: 'https://cdn/x.jpg',
          previewImageUrl: 'https://cdn/x.jpg',
        },
      ],
    })
  })

  test('uses /reply and replyToken when replyTo is set', async () => {
    installFetch(() => new Response('{}', { status: 200 }))
    const t = new LineTransport(config)
    await t.send({ to: 'IGNORED', text: 'pong', replyTo: 'RTOKEN' })

    expect(calls[0]!.url).toBe('https://api.line.test/v2/bot/message/reply')
    expect(calls[0]!.body).toEqual({
      replyToken: 'RTOKEN',
      messages: [{ type: 'text', text: 'pong' }],
    })
  })

  test('rejects more than 5 messages per call', async () => {
    const t = new LineTransport(config)
    await expect(
      t.send({
        to: 'U1',
        text: 'hi',
        media: Array.from({ length: 5 }, () => ({
          kind: 'image' as const,
          url: 'https://cdn/x.jpg',
        })),
      })
    ).rejects.toBeInstanceOf(ExternalServiceError)
  })

  test('throws ExternalServiceError on non-2xx with provider message', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ message: 'Invalid reply token' }), { status: 400 })
    )
    const t = new LineTransport(config)
    await expect(
      t.send({ to: 'U1', text: 'hi', replyTo: 'expired' })
    ).rejects.toBeInstanceOf(ExternalServiceError)
  })
})
