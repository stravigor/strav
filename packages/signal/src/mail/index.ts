export { default, default as MailManager } from './mail_manager.ts'
export { mail, PendingMail } from './helpers.ts'
export { SmtpTransport } from './transports/smtp_transport.ts'
export { ResendTransport } from './transports/resend_transport.ts'
export { SendGridTransport } from './transports/sendgrid_transport.ts'
export { MailgunTransport } from './transports/mailgun_transport.ts'
export { AlibabaTransport } from './transports/alibaba_transport.ts'
export { LogTransport } from './transports/log_transport.ts'
export { inlineCss } from './css_inliner.ts'
export * from './inbound/index.ts'
export type {
  MailTransport,
  MailMessage,
  MailResult,
  MailAttachment,
  MailConfig,
  SmtpConfig,
  ResendConfig,
  SendGridConfig,
  MailgunConfig,
  AlibabaConfig,
  LogConfig,
} from './types.ts'
export type { InlinerOptions } from './css_inliner.ts'
