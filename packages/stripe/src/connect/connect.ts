import type Stripe from 'stripe'
import { extractUserId } from '@strav/database'
import StripeManager from '../stripe_manager.ts'
import { ConnectNotConfiguredError } from '../errors.ts'
import type { ConnectAccountData, ConnectAccountStatus, ConnectAccountType } from '../types.ts'

/**
 * Stripe Connect account management.
 *
 * Wraps `stripe.accounts.*` and `stripe.accountLinks.*` and keeps a local
 * mirror in `strav_stripe_connect_account` for fast lookup. The mirror is
 * synced on creation and on each `account.updated` / `capability.updated`
 * webhook (wired in `src/webhook.ts`).
 *
 * Gated by `config.stripe.connect.enabled`. Throws
 * {@link ConnectNotConfiguredError} when called with Connect disabled.
 *
 * @example
 * const acct = await StripeConnect.createAccount(freelancer, {
 *   email: 'freelancer@example.com',
 * })
 * const link = await StripeConnect.createAccountLink(acct.stripeAccountId)
 * // → redirect freelancer to link.url
 */
export default class StripeConnect {
  private static get sql() {
    return StripeManager.db.sql
  }

  private static get fk() {
    return StripeManager.userFkColumn
  }

  private static assertEnabled(): void {
    if (!StripeManager.config.connect.enabled) {
      throw new ConnectNotConfiguredError()
    }
  }

  /**
   * Create a Stripe Connect account and persist a local mirror.
   *
   * Defaults pulled from `config.stripe.connect.*`; override per call via
   * `params`. The created Stripe account ID becomes the unique key on the
   * local row.
   */
  static async createAccount(
    user: unknown,
    params: Partial<Stripe.AccountCreateParams> = {}
  ): Promise<ConnectAccountData> {
    StripeConnect.assertEnabled()

    const userId = extractUserId(user)
    const cfg = StripeManager.config.connect

    const accountType = (params.type ?? cfg.accountType) as ConnectAccountType
    const country = params.country ?? cfg.defaultCountry
    const businessType = (params.business_type ?? cfg.defaultBusinessType) as
      | Stripe.AccountCreateParams.BusinessType
    const { type: _t, country: _c, business_type: _bt, metadata, ...rest } = params

    const stripeAccount = await StripeManager.stripe.accounts.create({
      type: accountType,
      country,
      business_type: businessType,
      metadata: { strav_user_id: String(userId), ...(metadata ?? {}) },
      ...rest,
    })

    const fk = StripeConnect.fk
    const rows = await StripeConnect.sql.unsafe(
      `INSERT INTO "strav_stripe_connect_account"
         ("${fk}", "stripe_account_id", "account_type", "country",
          "charges_enabled", "payouts_enabled", "details_submitted",
          "capabilities", "requirements")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        userId,
        stripeAccount.id,
        accountType,
        country,
        stripeAccount.charges_enabled ?? false,
        stripeAccount.payouts_enabled ?? false,
        stripeAccount.details_submitted ?? false,
        stripeAccount.capabilities ? JSON.stringify(stripeAccount.capabilities) : null,
        stripeAccount.requirements ? JSON.stringify(stripeAccount.requirements) : null,
      ]
    )
    return StripeConnect.hydrate(rows[0] as Record<string, unknown>)
  }

  /**
   * Create a Stripe-hosted onboarding link. Returns the full URL the user
   * should be redirected to.
   */
  static async createAccountLink(
    stripeAccountId: string,
    options: {
      refreshUrl?: string
      returnUrl?: string
      type?: Stripe.AccountLinkCreateParams.Type
      collect?: Stripe.AccountLinkCreateParams.Collect
    } = {}
  ): Promise<Stripe.AccountLink> {
    StripeConnect.assertEnabled()
    const cfg = StripeManager.config.connect

    return StripeManager.stripe.accountLinks.create({
      account: stripeAccountId,
      refresh_url: options.refreshUrl ?? cfg.refreshUrl,
      return_url: options.returnUrl ?? cfg.returnUrl,
      type: options.type ?? 'account_onboarding',
      ...(options.collect ? { collect: options.collect } : {}),
    })
  }

  /**
   * Fetch the current onboarding status from Stripe. Does not touch the
   * local mirror; for that, wait for the `account.updated` webhook or call
   * {@link syncFromStripe} explicitly.
   */
  static async getAccountStatus(stripeAccountId: string): Promise<ConnectAccountStatus> {
    StripeConnect.assertEnabled()
    const acct = await StripeManager.stripe.accounts.retrieve(stripeAccountId)
    return {
      chargesEnabled: acct.charges_enabled ?? false,
      payoutsEnabled: acct.payouts_enabled ?? false,
      detailsSubmitted: acct.details_submitted ?? false,
      capabilities: (acct.capabilities as Record<string, unknown>) ?? null,
      requirements: (acct.requirements as unknown as Record<string, unknown>) ?? null,
    }
  }

  /** Find the local Connect account record for a user. */
  static async findByUser(user: unknown): Promise<ConnectAccountData | null> {
    const userId = extractUserId(user)
    const fk = StripeConnect.fk
    const rows = await StripeConnect.sql.unsafe(
      `SELECT * FROM "strav_stripe_connect_account" WHERE "${fk}" = $1 LIMIT 1`,
      [userId]
    )
    return rows.length > 0 ? StripeConnect.hydrate(rows[0] as Record<string, unknown>) : null
  }

  /** Find the local Connect account record by Stripe account ID. */
  static async findByStripeId(stripeAccountId: string): Promise<ConnectAccountData | null> {
    const rows = await StripeConnect.sql`
      SELECT * FROM "strav_stripe_connect_account"
      WHERE "stripe_account_id" = ${stripeAccountId} LIMIT 1
    `
    return rows.length > 0 ? StripeConnect.hydrate(rows[0] as Record<string, unknown>) : null
  }

  /**
   * Refresh the local mirror from a Stripe account object (typically from
   * an `account.updated` webhook payload).
   */
  static async syncFromStripe(stripeAccount: Stripe.Account): Promise<void> {
    await StripeConnect.sql`
      UPDATE "strav_stripe_connect_account"
      SET "charges_enabled" = ${stripeAccount.charges_enabled ?? false},
          "payouts_enabled" = ${stripeAccount.payouts_enabled ?? false},
          "details_submitted" = ${stripeAccount.details_submitted ?? false},
          "capabilities" = ${stripeAccount.capabilities ? JSON.stringify(stripeAccount.capabilities) : null},
          "requirements" = ${stripeAccount.requirements ? JSON.stringify(stripeAccount.requirements) : null},
          "updated_at" = NOW()
      WHERE "stripe_account_id" = ${stripeAccount.id}
    `
  }

  /** Delete the local Connect record. Does NOT delete the Stripe account. */
  static async deleteByUser(user: unknown): Promise<void> {
    const userId = extractUserId(user)
    const fk = StripeConnect.fk
    await StripeConnect.sql.unsafe(
      `DELETE FROM "strav_stripe_connect_account" WHERE "${fk}" = $1`,
      [userId]
    )
  }

  /** Delete the local Connect record by Stripe account ID. */
  static async deleteByStripeId(stripeAccountId: string): Promise<void> {
    await StripeConnect.sql`
      DELETE FROM "strav_stripe_connect_account"
      WHERE "stripe_account_id" = ${stripeAccountId}
    `
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private static hydrate(row: Record<string, unknown>): ConnectAccountData {
    const fk = StripeConnect.fk
    return {
      id: row.id as number,
      userId: row[fk] as string | number,
      stripeAccountId: row.stripe_account_id as string,
      accountType: row.account_type as ConnectAccountType,
      country: row.country as string,
      chargesEnabled: row.charges_enabled as boolean,
      payoutsEnabled: row.payouts_enabled as boolean,
      detailsSubmitted: row.details_submitted as boolean,
      capabilities: (row.capabilities as Record<string, unknown>) ?? null,
      requirements: (row.requirements as Record<string, unknown>) ?? null,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    }
  }
}
