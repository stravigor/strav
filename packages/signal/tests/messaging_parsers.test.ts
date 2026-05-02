import { describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { AuthenticationError, ConfigurationError } from '@strav/kernel'
import { WhatsAppInboundParser } from '../src/messaging/inbound/whatsapp_parser.ts'
import { MessengerInboundParser } from '../src/messaging/inbound/messenger_parser.ts'
import { LineInboundParser } from '../src/messaging/inbound/line_parser.ts'
import type { InboundWebhookInput } from '../src/mail/inbound/types.ts'

const APP_SECRET = 'test-app-secret'
const CHANNEL_SECRET = 'test-channel-secret'

function metaWebhook(payload: unknown, secret = APP_SECRET): InboundWebhookInput {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8')
  const sig = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex')
  return { body, headers: { 'x-hub-signature-256': sig } }
}

function lineWebhook(payload: unknown, secret = CHANNEL_SECRET): InboundWebhookInput {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8')
  const sig = createHmac('sha256', secret).update(body).digest('base64')
  return { body, headers: { 'x-line-signature': sig } }
}

describe('WhatsAppInboundParser', () => {
  test('parses a text message with profile name', async () => {
    const parser = new WhatsAppInboundParser({ appSecret: APP_SECRET })
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA_ID',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { display_phone_number: '15551112222', phone_number_id: 'PNID' },
                contacts: [{ profile: { name: 'Alice' }, wa_id: '15553334444' }],
                messages: [
                  {
                    from: '15553334444',
                    id: 'wamid.A',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'hello' },
                  },
                ],
              },
            },
          ],
        },
      ],
    }
    const result = await parser.parse(metaWebhook(payload))

    expect(result).toHaveLength(1)
    expect(result[0]!.provider).toBe('whatsapp')
    expect(result[0]!.conversationId).toBe('15553334444')
    expect(result[0]!.fromUserId).toBe('15553334444')
    expect(result[0]!.fromName).toBe('Alice')
    expect(result[0]!.text).toBe('hello')
    expect(result[0]!.media).toEqual([])
    expect(result[0]!.providerMessageId).toBe('wamid.A')
    expect(result[0]!.receivedAt.getTime()).toBe(1700000000 * 1000)
  })

  test('maps image, document, and voice messages to media', async () => {
    const parser = new WhatsAppInboundParser({ appSecret: APP_SECRET })
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                contacts: [],
                messages: [
                  {
                    from: '15550000000',
                    id: 'm1',
                    timestamp: '1700000001',
                    type: 'image',
                    image: { id: 'media1', mime_type: 'image/jpeg', caption: 'pic' },
                  },
                  {
                    from: '15550000000',
                    id: 'm2',
                    timestamp: '1700000002',
                    type: 'document',
                    document: { id: 'media2', filename: 'report.pdf', mime_type: 'application/pdf' },
                  },
                  {
                    from: '15550000000',
                    id: 'm3',
                    timestamp: '1700000003',
                    type: 'voice',
                    voice: { id: 'media3', mime_type: 'audio/ogg' },
                  },
                ],
              },
            },
          ],
        },
      ],
    }
    const result = await parser.parse(metaWebhook(payload))

    expect(result).toHaveLength(3)
    expect(result[0]!.media[0]).toEqual({
      kind: 'image',
      mediaId: 'media1',
      contentType: 'image/jpeg',
      caption: 'pic',
    })
    expect(result[1]!.media[0]).toEqual({
      kind: 'file',
      mediaId: 'media2',
      filename: 'report.pdf',
      contentType: 'application/pdf',
    })
    expect(result[2]!.media[0]).toEqual({
      kind: 'audio',
      mediaId: 'media3',
      contentType: 'audio/ogg',
    })
  })

  test('skips status events (no messages array)', async () => {
    const parser = new WhatsAppInboundParser({ appSecret: APP_SECRET })
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [{ id: 'wamid.X', status: 'read', recipient_id: '15553334444' }],
              },
            },
          ],
        },
      ],
    }
    const result = await parser.parse(metaWebhook(payload))
    expect(result).toEqual([])
  })

  test('rejects payload with tampered signature', async () => {
    const parser = new WhatsAppInboundParser({ appSecret: APP_SECRET })
    const input = metaWebhook({ entry: [] }, 'different-secret')
    await expect(parser.parse(input)).rejects.toBeInstanceOf(AuthenticationError)
  })

  test('rejects payload with missing signature header', async () => {
    const parser = new WhatsAppInboundParser({ appSecret: APP_SECRET })
    await expect(
      parser.parse({ body: '{}', headers: {} })
    ).rejects.toBeInstanceOf(AuthenticationError)
  })

  test('throws ConfigurationError when appSecret is missing', () => {
    expect(() => new WhatsAppInboundParser({ appSecret: '' })).toThrow(ConfigurationError)
  })
})

describe('MessengerInboundParser', () => {
  test('parses a text message and resolves PSID', async () => {
    const parser = new MessengerInboundParser({ appSecret: APP_SECRET })
    const payload = {
      object: 'page',
      entry: [
        {
          id: 'PAGE_ID',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'PSID_USER' },
              recipient: { id: 'PAGE_ID' },
              timestamp: 1700000000000,
              message: { mid: 'mid.A', text: 'hi page' },
            },
          ],
        },
      ],
    }
    const result = await parser.parse(metaWebhook(payload))

    expect(result).toHaveLength(1)
    expect(result[0]!.provider).toBe('messenger')
    expect(result[0]!.conversationId).toBe('PSID_USER')
    expect(result[0]!.fromUserId).toBe('PSID_USER')
    expect(result[0]!.text).toBe('hi page')
    expect(result[0]!.providerMessageId).toBe('mid.A')
    expect(result[0]!.receivedAt.getTime()).toBe(1700000000000)
  })

  test('maps attachments to media', async () => {
    const parser = new MessengerInboundParser({ appSecret: APP_SECRET })
    const payload = {
      entry: [
        {
          messaging: [
            {
              sender: { id: 'PSID' },
              timestamp: 1,
              message: {
                mid: 'mid.media',
                attachments: [
                  { type: 'image', payload: { url: 'https://cdn.example/x.jpg' } },
                  { type: 'file', payload: { url: 'https://cdn.example/y.pdf' } },
                  { type: 'fallback', payload: {} },
                ],
              },
            },
          ],
        },
      ],
    }
    const result = await parser.parse(metaWebhook(payload))
    expect(result[0]!.media).toEqual([
      { kind: 'image', url: 'https://cdn.example/x.jpg' },
      { kind: 'file', url: 'https://cdn.example/y.pdf' },
    ])
  })

  test('filters out echoes', async () => {
    const parser = new MessengerInboundParser({ appSecret: APP_SECRET })
    const payload = {
      entry: [
        {
          messaging: [
            {
              sender: { id: 'PAGE' },
              timestamp: 1,
              message: { mid: 'mid.echo', text: 'echo', is_echo: true },
            },
          ],
        },
      ],
    }
    const result = await parser.parse(metaWebhook(payload))
    expect(result).toEqual([])
  })

  test('filters out delivery and read events (no message)', async () => {
    const parser = new MessengerInboundParser({ appSecret: APP_SECRET })
    const payload = {
      entry: [
        {
          messaging: [
            { sender: { id: 'PSID' }, timestamp: 1, delivery: { mids: ['m1'], watermark: 1 } },
            { sender: { id: 'PSID' }, timestamp: 1, read: { watermark: 1 } },
          ],
        },
      ],
    }
    const result = await parser.parse(metaWebhook(payload))
    expect(result).toEqual([])
  })

  test('rejects tampered signature', async () => {
    const parser = new MessengerInboundParser({ appSecret: APP_SECRET })
    const input = metaWebhook({ entry: [] }, 'other')
    await expect(parser.parse(input)).rejects.toBeInstanceOf(AuthenticationError)
  })
})

describe('LineInboundParser', () => {
  test('parses a text message from a 1:1 user with replyToken', async () => {
    const parser = new LineInboundParser({ channelSecret: CHANNEL_SECRET })
    const payload = {
      destination: 'BOT_ID',
      events: [
        {
          type: 'message',
          replyToken: 'RTOKEN',
          mode: 'active',
          timestamp: 1700000000000,
          source: { type: 'user', userId: 'U1' },
          message: { id: '1001', type: 'text', text: 'hi line' },
        },
      ],
    }
    const result = await parser.parse(lineWebhook(payload))

    expect(result).toHaveLength(1)
    expect(result[0]!.provider).toBe('line')
    expect(result[0]!.conversationId).toBe('U1')
    expect(result[0]!.fromUserId).toBe('U1')
    expect(result[0]!.text).toBe('hi line')
    expect(result[0]!.providerMessageId).toBe('1001')
    expect(result[0]!.replyToken).toBe('RTOKEN')
    expect(result[0]!.receivedAt.getTime()).toBe(1700000000000)
  })

  test('uses groupId as conversationId for group messages and keeps userId on fromUserId', async () => {
    const parser = new LineInboundParser({ channelSecret: CHANNEL_SECRET })
    const payload = {
      events: [
        {
          type: 'message',
          replyToken: 'RT',
          timestamp: 1,
          source: { type: 'group', groupId: 'G1', userId: 'U1' },
          message: { id: '2002', type: 'text', text: 'group msg' },
        },
      ],
    }
    const result = await parser.parse(lineWebhook(payload))
    expect(result[0]!.conversationId).toBe('G1')
    expect(result[0]!.fromUserId).toBe('U1')
  })

  test('maps file media including filename', async () => {
    const parser = new LineInboundParser({ channelSecret: CHANNEL_SECRET })
    const payload = {
      events: [
        {
          type: 'message',
          timestamp: 1,
          source: { type: 'user', userId: 'U1' },
          message: { id: '3003', type: 'file', fileName: 'doc.pdf', fileSize: 12345 },
        },
      ],
    }
    const result = await parser.parse(lineWebhook(payload))
    expect(result[0]!.media).toEqual([{ kind: 'file', mediaId: '3003', filename: 'doc.pdf' }])
  })

  test('skips non-message event types', async () => {
    const parser = new LineInboundParser({ channelSecret: CHANNEL_SECRET })
    const payload = {
      events: [
        { type: 'follow', timestamp: 1, source: { type: 'user', userId: 'U1' } },
        { type: 'unfollow', timestamp: 1, source: { type: 'user', userId: 'U2' } },
      ],
    }
    const result = await parser.parse(lineWebhook(payload))
    expect(result).toEqual([])
  })

  test('rejects payload with tampered signature', async () => {
    const parser = new LineInboundParser({ channelSecret: CHANNEL_SECRET })
    const input = lineWebhook({ events: [] }, 'wrong-secret')
    await expect(parser.parse(input)).rejects.toBeInstanceOf(AuthenticationError)
  })
})
