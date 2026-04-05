import { ServiceProvider } from '@strav/kernel'
import type { Application } from '@strav/kernel'
import MailManager from '../mail/mail_manager.ts'

export default class MailProvider extends ServiceProvider {
  readonly name = 'mail'
  override readonly dependencies = ['config']

  override register(app: Application): void {
    app.singleton(MailManager)
  }

  override boot(app: Application): void {
    app.resolve(MailManager)
  }
}
