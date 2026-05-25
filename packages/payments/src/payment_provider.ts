import { ServiceProvider } from '@strav/kernel'
import type { Application } from '@strav/kernel'
import PaymentManager from './payment_manager.ts'

/**
 * Service provider for @strav/payments.
 *
 * Registers PaymentManager as a singleton. Apps register concrete
 * gateways themselves (typically in bootstrap or in the `boot()` phase
 * of an app-specific provider) because each gateway needs platform-
 * specific configuration that doesn't belong in this package's defaults.
 *
 *   app.use(new PaymentProvider())
 *
 *   PaymentManager.register(new OmiseGateway({
 *     secretKey: env('OMISE_SECRET_KEY'),
 *     webhookSecret: env('OMISE_WEBHOOK_SECRET'),
 *   }))
 */
export default class PaymentProvider extends ServiceProvider {
  readonly name = 'payments'
  override readonly dependencies = ['config']

  override register(app: Application): void {
    app.singleton(PaymentManager)
  }

  override boot(app: Application): void {
    app.resolve(PaymentManager)
  }
}
