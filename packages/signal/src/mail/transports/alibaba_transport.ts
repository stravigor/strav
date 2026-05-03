import crypto from 'node:crypto'
import { ExternalServiceError, scrubProviderError } from '@strav/kernel'
import type { MailTransport, MailMessage, MailResult, AlibabaConfig } from '../types.ts'

/**
 * Alibaba Cloud DirectMail (SingleSendMail) transport.
 * Uses fetch with HMAC-SHA1 signature — no SDK dependency required.
 *
 * Note: SingleSendMail does not support CC, BCC, or attachments.
 * Use the SMTP interface for those features.
 *
 * @see https://www.alibabacloud.com/help/en/directmail/latest/SingleSendMail
 */
export class AlibabaTransport implements MailTransport {
  private accessKeyId: string
  private accessKeySecret: string
  private accountName: string
  private region: string

  constructor(config: AlibabaConfig) {
    this.accessKeyId = config.accessKeyId
    this.accessKeySecret = config.accessKeySecret
    this.accountName = config.accountName
    this.region = config.region ?? 'cn-hangzhou'
  }

  async send(message: MailMessage): Promise<MailResult> {
    const toAddress = Array.isArray(message.to) ? message.to.join(',') : message.to

    const params: Record<string, string> = {
      Action: 'SingleSendMail',
      AccountName: this.accountName,
      AddressType: '1',
      ReplyToAddress: message.replyTo ? 'true' : 'false',
      ToAddress: toAddress,
      Subject: message.subject,
      Format: 'JSON',
      Version: '2015-11-23',
      AccessKeyId: this.accessKeyId,
      SignatureMethod: 'HMAC-SHA1',
      SignatureVersion: '1.0',
      SignatureNonce: crypto.randomUUID(),
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    }

    if (message.html) params.HtmlBody = message.html
    if (message.text) params.TextBody = message.text
    if (message.from) params.FromAlias = message.from

    const signature = this.sign(params)
    params.Signature = signature

    const body = new URLSearchParams(params).toString()
    const url = `https://dm.${this.region}.aliyuncs.com`

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new ExternalServiceError(
        'Alibaba DirectMail',
        response.status,
        scrubProviderError(error)
      )
    }

    const data = (await response.json()) as { EnvId?: string; RequestId?: string }
    const toArray = Array.isArray(message.to) ? message.to : [message.to]
    return { messageId: data.EnvId ?? data.RequestId, accepted: toArray }
  }

  private percentEncode(str: string): string {
    return encodeURIComponent(str).replace(/\+/g, '%20').replace(/\*/g, '%2A').replace(/~/g, '%7E')
  }

  private sign(params: Record<string, string>): string {
    const sortedKeys = Object.keys(params).sort()
    const canonicalized = sortedKeys
      .map(k => `${this.percentEncode(k)}=${this.percentEncode(params[k]!)}`)
      .join('&')

    const stringToSign = `POST&${this.percentEncode('/')}&${this.percentEncode(canonicalized)}`

    const hmac = crypto.createHmac('sha1', `${this.accessKeySecret}&`)
    hmac.update(stringToSign)
    return hmac.digest('base64')
  }
}
