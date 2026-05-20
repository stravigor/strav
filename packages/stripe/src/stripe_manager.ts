import Stripe from 'stripe'
import { inject, Configuration, ConfigurationError } from '@strav/kernel'
import { Database, toSnakeCase } from '@strav/database'
import type { StripeConfig } from './types.ts'

@inject
export default class StripeManager {
  private static _db: Database
  private static _config: StripeConfig
  private static _stripe: Stripe
  private static _userFkColumn: string

  constructor(db: Database, config: Configuration) {
    StripeManager._db = db

    const userKey = config.get('stripe.userKey', 'id') as string
    StripeManager._userFkColumn = `user_${toSnakeCase(userKey)}`

    const secret = config.get('stripe.secret', '') as string

    StripeManager._config = {
      secret,
      key: config.get('stripe.key', '') as string,
      webhookSecret: config.get('stripe.webhookSecret', '') as string,
      currency: config.get('stripe.currency', 'usd') as string,
      userKey,
      urls: {
        success: config.get('stripe.urls.success', '/billing/success') as string,
        cancel: config.get('stripe.urls.cancel', '/billing/cancel') as string,
      },
      connect: {
        enabled: config.get('stripe.connect.enabled', false) as boolean,
        accountType: config.get('stripe.connect.accountType', 'express') as
          | 'express'
          | 'custom'
          | 'standard',
        defaultCountry: config.get('stripe.connect.defaultCountry', 'US') as string,
        defaultBusinessType: config.get(
          'stripe.connect.defaultBusinessType',
          'individual'
        ) as 'individual' | 'company' | 'non_profit' | 'government_entity',
        refreshUrl: config.get('stripe.connect.refreshUrl', '/billing/connect/refresh') as string,
        returnUrl: config.get('stripe.connect.returnUrl', '/billing/connect/complete') as string,
      },
      webhook: {
        idempotency: config.get('stripe.webhook.idempotency', false) as boolean,
      },
    }

    if (secret) {
      StripeManager._stripe = new Stripe(secret)
    }
  }

  static get db(): Database {
    if (!StripeManager._db) {
      throw new ConfigurationError(
        'StripeManager not configured. Resolve it through the container first.'
      )
    }
    return StripeManager._db
  }

  static get config(): StripeConfig {
    if (!StripeManager._config) {
      throw new ConfigurationError(
        'StripeManager not configured. Resolve it through the container first.'
      )
    }
    return StripeManager._config
  }

  static get stripe(): Stripe {
    if (!StripeManager._stripe) {
      throw new ConfigurationError('StripeManager not configured. Ensure STRIPE_SECRET is set.')
    }
    return StripeManager._stripe
  }

  /** The FK column name on stripe tables (e.g. `user_id`, `user_uid`). */
  static get userFkColumn(): string {
    return StripeManager._userFkColumn ?? 'user_id'
  }

  /** Reset internal state (useful for testing). */
  static reset(): void {
    StripeManager._db = undefined as any
    StripeManager._config = undefined as any
    StripeManager._stripe = undefined as any
    StripeManager._userFkColumn = undefined as any
  }
}
