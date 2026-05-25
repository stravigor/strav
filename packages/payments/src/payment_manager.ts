import { inject, Configuration, ConfigurationError } from '@strav/kernel'
import { GatewayNotRegisteredError } from './errors.ts'
import type { Gateway } from './gateway.ts'

/**
 * Central registry + default gateway resolver.
 *
 * Apps typically register one production gateway plus an optional test
 * fake. `PaymentManager.gateway()` returns the configured default;
 * `.gateway('stripe')` returns a specific one.
 *
 * Configuration:
 *   payments:
 *     default: 'omise'  // or 'stripe' — must match a registered Gateway.name
 *
 * Wiring example:
 *
 *   app.use(new PaymentProvider())
 *   PaymentManager.register(new OmiseGateway({ secretKey: env('OMISE_SECRET') }))
 *
 *   // Or register both and pick per-call:
 *   PaymentManager.register(new StripeGateway({ secretKey: env('STRIPE_SECRET') }))
 *   const charge = await PaymentManager.gateway('stripe').charge({ ... })
 */
@inject
export default class PaymentManager {
  private static _gateways = new Map<string, Gateway>()
  private static _defaultName?: string

  constructor(config: Configuration) {
    const defaultName = config.get('payments.default') as string | undefined
    if (defaultName) PaymentManager._defaultName = defaultName
  }

  /** Register a gateway. The first registered becomes the default if none is configured. */
  static register(gateway: Gateway): void {
    PaymentManager._gateways.set(gateway.name, gateway)
    if (!PaymentManager._defaultName) PaymentManager._defaultName = gateway.name
  }

  /** Look up a gateway by name; throws if absent. */
  static gateway(name?: string): Gateway {
    const key = name ?? PaymentManager._defaultName
    if (!key) {
      throw new ConfigurationError(
        'No default payments gateway configured. Set config.payments.default or call PaymentManager.register() first.'
      )
    }
    const gateway = PaymentManager._gateways.get(key)
    if (!gateway) throw new GatewayNotRegisteredError(key)
    return gateway
  }

  /** Whether a gateway is registered under `name`. */
  static has(name: string): boolean {
    return PaymentManager._gateways.has(name)
  }

  /** Set or change the default gateway at runtime. */
  static setDefault(name: string): void {
    if (!PaymentManager._gateways.has(name)) {
      throw new GatewayNotRegisteredError(name)
    }
    PaymentManager._defaultName = name
  }

  /** Clear all registered gateways. For testing only. */
  static reset(): void {
    PaymentManager._gateways.clear()
    PaymentManager._defaultName = undefined
  }
}
