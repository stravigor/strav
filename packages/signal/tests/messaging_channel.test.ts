import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import MessagingManager from '../src/messaging/messaging_manager.ts'
import { MessagingChannel } from '../src/messaging/channels/messaging_channel.ts'
import type {
  MessagingMessage,
  MessagingResult,
  MessagingTransport,
} from '../src/messaging/types.ts'
import type { Notifiable, NotificationPayload } from '../src/notification/types.ts'

class FakeTransport implements MessagingTransport {
  readonly sent: MessagingMessage[] = []
  constructor(public readonly name: string) {}
  async send(message: MessagingMessage): Promise<MessagingResult> {
    this.sent.push(message)
    return { providerMessageId: `${this.name}-id` }
  }
}

const recipient: Notifiable = {
  notifiableId: () => 'u1',
  notifiableType: () => 'user',
  routeNotificationForWhatsapp: () => '+15551112222',
  routeNotificationForMessenger: () => 'PSID',
  routeNotificationForLine: () => 'U1',
}

const recipientNoRoutes: Notifiable = {
  notifiableId: () => 'u2',
  notifiableType: () => 'user',
}

beforeEach(() => {
  MessagingManager.reset()
})

afterEach(() => {
  MessagingManager.reset()
})

describe('MessagingChannel', () => {
  test('whatsapp channel dispatches via WhatsApp transport with the right route', async () => {
    const transport = new FakeTransport('whatsapp')
    MessagingManager.useTransport(transport)
    const channel = new MessagingChannel('whatsapp')

    const payload: NotificationPayload = {
      notificationClass: 'TestPing',
      channels: ['whatsapp'],
      whatsapp: { text: 'hi via wa', media: [{ kind: 'image', url: 'https://cdn/x.jpg' }] },
    }

    await channel.send(recipient, payload)

    expect(transport.sent).toHaveLength(1)
    expect(transport.sent[0]).toEqual({
      to: '+15551112222',
      text: 'hi via wa',
      media: [{ kind: 'image', url: 'https://cdn/x.jpg' }],
      replyTo: undefined,
    })
  })

  test('messenger and line channels read their own envelope', async () => {
    const messenger = new FakeTransport('messenger')
    const line = new FakeTransport('line')
    MessagingManager.useTransport(messenger)
    MessagingManager.useTransport(line)

    const payload: NotificationPayload = {
      notificationClass: 'TestPing',
      channels: ['messenger', 'line'],
      messenger: { text: 'hi via fb' },
      line: { text: 'hi via line', replyTo: 'RT' },
    }

    await new MessagingChannel('messenger').send(recipient, payload)
    await new MessagingChannel('line').send(recipient, payload)

    expect(messenger.sent).toEqual([
      { to: 'PSID', text: 'hi via fb', media: undefined, replyTo: undefined },
    ])
    expect(line.sent).toEqual([
      { to: 'U1', text: 'hi via line', media: undefined, replyTo: 'RT' },
    ])
  })

  test('skips delivery when the matching envelope is missing', async () => {
    const transport = new FakeTransport('whatsapp')
    MessagingManager.useTransport(transport)
    const channel = new MessagingChannel('whatsapp')

    await channel.send(recipient, {
      notificationClass: 'TestPing',
      channels: ['whatsapp'],
      // no whatsapp envelope
    })

    expect(transport.sent).toEqual([])
  })

  test('skips delivery when the recipient has no route for the provider', async () => {
    const transport = new FakeTransport('whatsapp')
    MessagingManager.useTransport(transport)
    const channel = new MessagingChannel('whatsapp')

    await channel.send(recipientNoRoutes, {
      notificationClass: 'TestPing',
      channels: ['whatsapp'],
      whatsapp: { text: 'orphan' },
    })

    expect(transport.sent).toEqual([])
  })

  test('throws when the targeted provider is not configured', async () => {
    // No transport registered for 'line'
    const channel = new MessagingChannel('line')
    await expect(
      channel.send(recipient, {
        notificationClass: 'TestPing',
        channels: ['line'],
        line: { text: 'hi' },
      })
    ).rejects.toThrow(/messaging provider: line/)
  })
})
