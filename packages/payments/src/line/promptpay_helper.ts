import {
  LineClient,
  bubble,
  box,
  button,
  flexMessage,
  image,
  separator,
  text,
  uriAction,
} from '@strav/line'
import type { FlexBubble, FlexMessage, LineClientConfig } from '@strav/line'
import { PaymentError } from '../errors.ts'
import type { Charge, PromptPayAction } from '../types.ts'

export interface PromptPayFlexOptions {
  /** Alt text shown in the LINE chat list. Defaults to a generic Thai label. */
  altText?: string
  /** Headline shown above the QR (defaults to "Scan to pay"). */
  title?: string
  /** Short subtitle, e.g. "Acme — Hotel tier — May 2026". */
  subtitle?: string
  /** Pre-formatted amount string, e.g. "฿890.00". Omit to suppress. */
  amountDisplay?: string
  /** Optional URL to a hosted "instructions" page (opens in LIFF / browser). */
  instructionsUrl?: string
  /** Label for the instructions button. Defaults to "View instructions". */
  instructionsLabel?: string
}

/**
 * Build a LINE Flex bubble that presents a PromptPay QR for the customer
 * to scan.
 *
 * The QR image URL is taken from `Charge.nextAction.imageUrl` — both
 * Omise and Stripe surface a hosted PNG there, so the same builder works
 * for either gateway.
 *
 * Throws PaymentError if the charge has no `requires_action` PromptPay
 * `nextAction` — callers should branch on `charge.status` themselves and
 * only invoke this when the charge is waiting on a scan.
 */
export function promptPayFlex(
  charge: Charge,
  options: PromptPayFlexOptions = {}
): FlexMessage {
  const action = charge.nextAction
  if (!action || action.type !== 'promptpay_display_qr' || !action.imageUrl) {
    throw new PaymentError(
      'payments',
      'promptPayFlex requires a charge with nextAction.imageUrl (status requires_action)'
    )
  }

  const body = box(
    'vertical',
    [
      text(options.title ?? 'Scan to pay', { weight: 'bold', size: 'lg', align: 'center' }),
      ...(options.subtitle
        ? [text(options.subtitle, { size: 'sm', color: '#888888', wrap: true, align: 'center', margin: 'sm' })]
        : []),
      image(action.imageUrl, {
        margin: 'lg',
        size: 'full',
        aspectRatio: '1:1',
        aspectMode: 'fit',
      }),
      ...(options.amountDisplay
        ? [
            separator({ margin: 'lg' }),
            text(options.amountDisplay, {
              weight: 'bold',
              size: 'xl',
              align: 'center',
              margin: 'lg',
            }),
          ]
        : []),
    ],
    { spacing: 'sm' }
  )

  const card: FlexBubble = options.instructionsUrl
    ? bubble({
        body,
        footer: box(
          'vertical',
          [
            button(
              uriAction(options.instructionsUrl, options.instructionsLabel ?? 'View instructions'),
              { style: 'secondary', height: 'sm' }
            ),
          ]
        ),
      })
    : bubble({ body })

  return flexMessage(options.altText ?? 'PromptPay QR — scan to pay', card)
}

export interface SendPromptPayQrOptions extends PromptPayFlexOptions {
  /** Recipient LINE user/group/room id (the SME owner who pays). */
  to: string
  /**
   * Optional pre-built LineClient. If omitted, a one-off LineClient is
   * constructed from the supplied `channelAccessToken` — convenient for
   * multi-tenant flows where each tenant has their own LINE OA.
   */
  client?: LineClient
  /** Channel access token, used when `client` is not supplied. */
  channelAccessToken?: string
  /** Forwarded to LineClient if `client` isn't supplied. */
  baseUrl?: string
}

/**
 * Convenience that builds the Flex card and pushes it to a LINE recipient.
 *
 * Typical use:
 *
 *   // 1. Create a PromptPay charge through whichever gateway is configured.
 *   const charge = await PaymentManager.gateway().charge({
 *     amount: 89000, currency: 'thb', paymentMethodType: 'promptpay',
 *   })
 *
 *   // 2. Push the QR to the tenant's LINE OA so the SME can scan.
 *   await sendPromptPayQrViaLine(charge, {
 *     to: ownerLineUserId,
 *     channelAccessToken: tenantOaToken,
 *     subtitle: 'Acme — Hotel tier — May 2026',
 *     amountDisplay: '฿890.00',
 *   })
 */
export async function sendPromptPayQrViaLine(
  charge: Charge,
  options: SendPromptPayQrOptions
): Promise<void> {
  const message = promptPayFlex(charge, options)
  const client = options.client ?? buildClient(options)
  await client.push(options.to, message)
}

function buildClient(options: SendPromptPayQrOptions): LineClient {
  if (!options.channelAccessToken) {
    throw new PaymentError(
      'payments',
      'sendPromptPayQrViaLine requires either `client` or `channelAccessToken`'
    )
  }
  const config: LineClientConfig = { channelAccessToken: options.channelAccessToken }
  if (options.baseUrl) config.baseUrl = options.baseUrl
  return new LineClient(config)
}

// Used for testing — kept here so the inline helper above doesn't need to
// be exported separately. Mirrors the @strav/line / @strav/publish style.
export const _internal = { buildClient }
