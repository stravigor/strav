import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  promptPayFlex,
  sendPromptPayQrViaLine,
} from '../src/line/promptpay_helper.ts'
import { PaymentError } from '../src/errors.ts'
import type { Charge } from '../src/types.ts'
import { calls, installFetchQueue, resetCalls, restoreFetch } from './_fetch_mock.ts'

const baseCharge: Charge = {
  id: 'pi_1',
  amount: 89000,
  currency: 'thb',
  status: 'requires_action',
  nextAction: {
    type: 'promptpay_display_qr',
    imageUrl: 'https://cdn.example.com/qr.png',
    payload: '00020101021229370016A000000677010111...',
  },
  raw: {},
}

beforeEach(() => {
  resetCalls()
})

afterEach(() => {
  restoreFetch()
})

describe('promptPayFlex', () => {
  test('returns a Flex message carrying the QR image', () => {
    const message = promptPayFlex(baseCharge, {
      title: 'Scan to pay',
      subtitle: 'Acme — Hotel — May 2026',
      amountDisplay: '฿890.00',
    })
    expect(message.type).toBe('flex')
    expect(message.altText).toBe('PromptPay QR — scan to pay')
    const bubble = message.contents as { body: { contents: { type: string; url?: string; text?: string }[] } }
    const imageNode = bubble.body.contents.find(c => c.type === 'image')
    expect(imageNode?.url).toBe('https://cdn.example.com/qr.png')
  })

  test('adds a footer with instructions button when instructionsUrl is set', () => {
    const message = promptPayFlex(baseCharge, {
      instructionsUrl: 'https://help.example.com/promptpay',
    })
    const bubble = message.contents as { footer?: { contents: { action: { uri: string } }[] } }
    expect(bubble.footer?.contents?.[0]?.action.uri).toBe('https://help.example.com/promptpay')
  })

  test('throws when the charge has no PromptPay action', () => {
    const noAction = { ...baseCharge, nextAction: undefined }
    expect(() => promptPayFlex(noAction)).toThrow(PaymentError)
  })

  test('throws when nextAction has no imageUrl', () => {
    const noImage: Charge = {
      ...baseCharge,
      nextAction: { type: 'promptpay_display_qr' },
    }
    expect(() => promptPayFlex(noImage)).toThrow('imageUrl')
  })
})

describe('sendPromptPayQrViaLine', () => {
  test('pushes the Flex card to the recipient using the supplied channel token', async () => {
    installFetchQueue([Response.json({})])
    await sendPromptPayQrViaLine(baseCharge, {
      to: 'U1234',
      channelAccessToken: 'CAT',
      title: 'Scan to pay',
      amountDisplay: '฿890.00',
    })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://api.line.me/v2/bot/message/push')
    expect(calls[0]!.headers.authorization).toBe('Bearer CAT')
    const body = calls[0]!.body as { to: string; messages: { type: string }[] }
    expect(body.to).toBe('U1234')
    expect(body.messages[0]!.type).toBe('flex')
  })

  test('throws when neither client nor channelAccessToken is supplied', async () => {
    installFetchQueue([])
    await expect(
      sendPromptPayQrViaLine(baseCharge, { to: 'U1' })
    ).rejects.toThrow('channelAccessToken')
  })
})
