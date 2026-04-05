import { inject } from '@strav/kernel'
import { ConfigurationError } from '@strav/kernel'
import { Configuration } from '@strav/kernel'
import { SmtpTransport } from './transports/smtp_transport.ts'
import { ResendTransport } from './transports/resend_transport.ts'
import { SendGridTransport } from './transports/sendgrid_transport.ts'
import { MailgunTransport } from './transports/mailgun_transport.ts'
import { AlibabaTransport } from './transports/alibaba_transport.ts'
import { LogTransport } from './transports/log_transport.ts'
import type { MailTransport, MailConfig } from './types.ts'

/**
 * Central mail configuration hub.
 *
 * Resolved once via the DI container — reads the mail config
 * and initializes the appropriate transport driver.
 *
 * @example
 * app.singleton(MailManager)
 * app.resolve(MailManager)
 *
 * // Plug in a custom transport
 * MailManager.useTransport(new MyCustomTransport())
 */
@inject
export default class MailManager {
  private static _transport: MailTransport
  private static _config: MailConfig

  constructor(config: Configuration) {
    const driverName = config.get('mail.default', 'log') as string

    MailManager._config = {
      default: driverName,
      from: config.get('mail.from', 'noreply@localhost') as string,
      templatePrefix: config.get('mail.templatePrefix', 'emails') as string,
      inlineCss: config.get('mail.inlineCss', true) as boolean,
      tailwind: config.get('mail.tailwind', false) as boolean,
      smtp: {
        host: '127.0.0.1',
        port: 587,
        secure: false,
        ...(config.get('mail.smtp', {}) as object),
      },
      resend: {
        apiKey: '',
        ...(config.get('mail.resend', {}) as object),
      },
      sendgrid: {
        apiKey: '',
        ...(config.get('mail.sendgrid', {}) as object),
      },
      mailgun: {
        apiKey: '',
        domain: '',
        ...(config.get('mail.mailgun', {}) as object),
      },
      alibaba: {
        accessKeyId: '',
        accessKeySecret: '',
        accountName: '',
        ...(config.get('mail.alibaba', {}) as object),
      },
      log: {
        output: 'console',
        ...(config.get('mail.log', {}) as object),
      },
    }

    MailManager._transport = MailManager.createTransport(driverName)
  }

  private static createTransport(driver: string): MailTransport {
    switch (driver) {
      case 'smtp':
        return new SmtpTransport(MailManager._config.smtp)
      case 'resend':
        return new ResendTransport(MailManager._config.resend)
      case 'sendgrid':
        return new SendGridTransport(MailManager._config.sendgrid)
      case 'mailgun':
        return new MailgunTransport(MailManager._config.mailgun)
      case 'alibaba':
        return new AlibabaTransport(MailManager._config.alibaba)
      case 'log':
        return new LogTransport(MailManager._config.log)
      default:
        throw new ConfigurationError(
          `Unknown mail transport: ${driver}. Use MailManager.useTransport() for custom transports.`
        )
    }
  }

  static get transport(): MailTransport {
    if (!MailManager._transport) {
      throw new ConfigurationError(
        'MailManager not configured. Resolve it through the container first.'
      )
    }
    return MailManager._transport
  }

  static get config(): MailConfig {
    return MailManager._config
  }

  /** Swap the transport at runtime (e.g., for testing or a custom provider). */
  static useTransport(transport: MailTransport): void {
    MailManager._transport = transport
  }
}
