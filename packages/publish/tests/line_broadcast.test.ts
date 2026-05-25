import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { LineBroadcastPublisher } from '../src/publishers/line_broadcast.ts'
import { PublishError } from '../src/errors.ts'
import { calls, installFetch, resetCalls, restoreFetch } from './_fetch_mock.ts'
import { makeCredentials } from './_fixtures.ts'

const creds = () =>
  makeCredentials({ platform: 'line_broadcast', accountId: 'channel-1', accessToken: 'CAT' })

beforeEach(() => {
  resetCalls()
})

afterEach(() => {
  restoreFetch()
})

describe('LineBroadcastPublisher.publish', () => {
  test('broadcasts a text message via LINE Messaging API', async () => {
    installFetch(() => Response.json({}))
    const p = new LineBroadcastPublisher()

    await p.publish(creds(), { language: 'en', body: 'Promo today!' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.line.me/v2/bot/message/broadcast')
    expect(calls[0]!.headers.authorization).toBe('Bearer CAT')
    expect(calls[0]!.body).toMatchObject({
      messages: [{ type: 'text', text: 'Promo today!' }],
    })
  })

  test('attaches image media as a LINE image message', async () => {
    installFetch(() => Response.json({}))
    const p = new LineBroadcastPublisher()

    await p.publish(creds(), {
      language: 'en',
      body: 'New menu',
      media: [{ kind: 'image', url: 'https://cdn.test/x.jpg' }],
    })

    expect(calls[0]!.body).toMatchObject({
      messages: [
        { type: 'text', text: 'New menu' },
        { type: 'image', originalContentUrl: 'https://cdn.test/x.jpg', previewImageUrl: 'https://cdn.test/x.jpg' },
      ],
    })
  })

  test('truncates to 5 messages (LINE limit)', async () => {
    installFetch(() => Response.json({}))
    const p = new LineBroadcastPublisher()

    await p.publish(creds(), {
      language: 'en',
      body: 'body',
      media: Array.from({ length: 6 }, (_, i) => ({
        kind: 'image' as const,
        url: `https://cdn.test/${i}.jpg`,
      })),
    })

    const body = calls[0]!.body as { messages: unknown[] }
    expect(body.messages).toHaveLength(5)
  })

  test('throws when both body and media are empty', async () => {
    installFetch(() => Response.json({}))
    const p = new LineBroadcastPublisher()
    await expect(
      p.publish(creds(), { language: 'en', body: '' })
    ).rejects.toThrow(PublishError)
  })
})
