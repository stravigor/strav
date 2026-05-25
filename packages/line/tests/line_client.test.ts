import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ExternalServiceError } from '@strav/kernel'
import { LineClient } from '../src/client/line_client.ts'
import { LINE_LIMITS } from '../src/types.ts'
import type { TextMessage } from '../src/types.ts'
import { calls, installFetch, resetCalls, restoreFetch } from './_fetch_mock.ts'

const config = {
  channelAccessToken: 'CAT',
  baseUrl: 'https://api.line.test',
  dataBaseUrl: 'https://data.line.test',
}

const textMessage = (t: string): TextMessage => ({ type: 'text', text: t })

beforeEach(() => {
  resetCalls()
})

afterEach(() => {
  restoreFetch()
})

describe('LineClient.push', () => {
  test('posts to /v2/bot/message/push with bearer auth', async () => {
    installFetch(() => Response.json({}))
    const c = new LineClient(config)

    await c.push('U1', textMessage('hi'))

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.line.test/v2/bot/message/push')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers.authorization).toBe('Bearer CAT')
    expect(calls[0]!.body).toEqual({
      to: 'U1',
      messages: [{ type: 'text', text: 'hi' }],
    })
  })

  test('rejects more than MESSAGES_PER_REQUEST', async () => {
    installFetch(() => Response.json({}))
    const c = new LineClient(config)
    const messages = Array.from({ length: LINE_LIMITS.MESSAGES_PER_REQUEST + 1 }, () =>
      textMessage('x')
    )

    await expect(c.push('U1', messages)).rejects.toThrow(ExternalServiceError)
  })

  test('throws on non-2xx with the LINE error message', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ message: 'Invalid reply token' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
    )
    const c = new LineClient(config)

    await expect(c.push('U1', textMessage('hi'))).rejects.toThrow('Invalid reply token')
  })
})

describe('LineClient.reply', () => {
  test('posts to /reply with the replyToken', async () => {
    installFetch(() => Response.json({}))
    const c = new LineClient(config)

    await c.reply('TOKEN', textMessage('hi'))

    expect(calls[0]!.url).toBe('https://api.line.test/v2/bot/message/reply')
    expect(calls[0]!.body).toMatchObject({ replyToken: 'TOKEN' })
  })

  test('rejects empty replyToken', async () => {
    installFetch(() => Response.json({}))
    const c = new LineClient(config)
    await expect(c.reply('', textMessage('hi'))).rejects.toThrow('replyToken')
  })
})

describe('LineClient.multicast', () => {
  test('posts the recipient list', async () => {
    installFetch(() => Response.json({}))
    const c = new LineClient(config)

    await c.multicast(['U1', 'U2'], textMessage('hi'))

    expect(calls[0]!.url).toBe('https://api.line.test/v2/bot/message/multicast')
    expect(calls[0]!.body).toMatchObject({ to: ['U1', 'U2'] })
  })

  test('rejects empty recipient list', async () => {
    installFetch(() => Response.json({}))
    const c = new LineClient(config)
    await expect(c.multicast([], textMessage('hi'))).rejects.toThrow('at least one recipient')
  })

  test('rejects more than MULTICAST_RECIPIENTS', async () => {
    installFetch(() => Response.json({}))
    const c = new LineClient(config)
    const recipients = Array.from(
      { length: LINE_LIMITS.MULTICAST_RECIPIENTS + 1 },
      (_, i) => `U${i}`
    )
    await expect(c.multicast(recipients, textMessage('hi'))).rejects.toThrow('at most')
  })
})

describe('LineClient.broadcast', () => {
  test('posts the message envelope', async () => {
    installFetch(() => Response.json({}))
    const c = new LineClient(config)

    await c.broadcast(textMessage('hi'), { notificationDisabled: true })

    expect(calls[0]!.url).toBe('https://api.line.test/v2/bot/message/broadcast')
    expect(calls[0]!.body).toMatchObject({
      messages: [{ type: 'text', text: 'hi' }],
      notificationDisabled: true,
    })
  })
})

describe('LineClient.downloadContent', () => {
  test('GETs the data API with bearer auth and returns bytes + content type', async () => {
    installFetch(
      () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'content-type': 'image/jpeg' },
        })
    )
    const c = new LineClient(config)

    const result = await c.downloadContent('MSG123')

    expect(calls[0]!.url).toBe('https://data.line.test/v2/bot/message/MSG123/content')
    expect(calls[0]!.headers.authorization).toBe('Bearer CAT')
    expect(Array.from(result.bytes)).toEqual([1, 2, 3, 4])
    expect(result.contentType).toBe('image/jpeg')
  })

  test('throws ExternalServiceError on non-2xx', async () => {
    installFetch(() => new Response('not found', { status: 404 }))
    const c = new LineClient(config)
    await expect(c.downloadContent('X')).rejects.toThrow(ExternalServiceError)
  })
})

describe('LineClient.getProfile', () => {
  test('GETs /v2/bot/profile/{userId}', async () => {
    installFetch(() =>
      Response.json({ userId: 'U1', displayName: 'Alice', pictureUrl: 'https://x' })
    )
    const c = new LineClient(config)

    const result = await c.getProfile('U1')

    expect(calls[0]!.url).toBe('https://api.line.test/v2/bot/profile/U1')
    expect(result.displayName).toBe('Alice')
  })
})
