import { ExternalServiceError } from '@strav/kernel'
import PublisherCredentials from '../credentials/credentials.ts'
import type { PublisherCredentialsData } from '../credentials/credentials.ts'
import {
  buildAuthUrl,
  exchangeCode,
  type OAuthClientConfig,
} from './oauth_helpers.ts'

export interface GoogleBusinessOAuthConfig extends OAuthClientConfig {}

interface GbpAccount {
  /** Resource name: `accounts/{accountId}` */
  name: string
  accountName?: string
  type?: string
}

interface GbpLocation {
  /** Resource name: `locations/{locationId}` */
  name: string
  title?: string
  storefrontAddress?: { locality?: string; regionCode?: string }
}

/**
 * OAuth + account/location-selection flow for Google Business Profile.
 *
 * The consent flow has three phases:
 *
 *   1. `authUrl()` → user grants the `business.manage` scope.
 *   2. `exchangeAndListAccounts()` → exchange code, list the user's GBP
 *      accounts. (GBP "accounts" are the org-level containers; each
 *      account holds 1..n locations.)
 *   3. `persistLocation()` → after the user picks which location to
 *      connect, persist the credentials row keyed on that location.
 *
 * Why two-step: a Google account that manages multiple locations needs a
 * UI step where the SME picks the right one. Auto-selecting a single
 * location works for the common case (most SMEs have one location).
 *
 * The GBP "Posts" API is gated — apps need allowlist approval from
 * Google before they can call /localPosts. Onboard via
 * https://developers.google.com/my-business/content/prereqs#api-access
 * before integrating in production.
 */
export class GoogleBusinessOAuth {
  private readonly config: GoogleBusinessOAuthConfig

  constructor(config: GoogleBusinessOAuthConfig) {
    this.config = config
  }

  authUrl(opts: { state: string; scopes?: string[] }): string {
    const scopes = opts.scopes ?? ['https://www.googleapis.com/auth/business.manage']
    return buildAuthUrl({
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      config: this.config,
      scopes,
      state: opts.state,
      extra: {
        // refresh_token is only issued when access_type=offline and the
        // user hasn't previously granted; force prompt=consent to keep
        // the dev flow reproducible.
        access_type: 'offline',
        prompt: 'consent',
        include_granted_scopes: 'true',
      },
    })
  }

  /**
   * Exchange the OAuth code and return the user's GBP accounts. The
   * tokens are returned but NOT persisted yet — the caller drives the
   * "pick a location" UI and then calls `persistLocation()`.
   */
  async exchangeAndListAccounts(opts: { code: string }): Promise<{
    accessToken: string
    refreshToken: string | null
    expiresIn: number | null
    accounts: GbpAccount[]
  }> {
    const token = await exchangeCode({
      tokenUrl: 'https://oauth2.googleapis.com/token',
      config: this.config,
      code: opts.code,
      secretIn: 'post',
    })
    const accounts = await this.fetchAccounts(token.accessToken)
    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresIn: token.expiresIn,
      accounts,
    }
  }

  /** List the locations under a given GBP account. */
  async listLocations(opts: { accessToken: string; accountName: string }): Promise<GbpLocation[]> {
    const url = `https://mybusinessbusinessinformation.googleapis.com/v1/${opts.accountName}/locations?readMask=name,title,storefrontAddress`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${opts.accessToken}` },
    })
    if (!response.ok) {
      throw new ExternalServiceError('GoogleBusiness', response.status, await response.text())
    }
    const body = (await response.json()) as { locations?: GbpLocation[] }
    return body.locations ?? []
  }

  /** Persist credentials keyed to a specific location. */
  async persistLocation(opts: {
    tenantId: string | number
    accountName: string
    locationName: string
    accessToken: string
    refreshToken: string | null
    expiresIn: number | null
    locationTitle?: string
  }): Promise<PublisherCredentialsData> {
    return PublisherCredentials.upsert({
      tenantId: opts.tenantId,
      platform: 'google_business',
      accountId: opts.locationName,
      accessToken: opts.accessToken,
      refreshToken: opts.refreshToken,
      expiresAt:
        opts.expiresIn != null ? new Date(Date.now() + opts.expiresIn * 1000) : null,
      scopes: ['https://www.googleapis.com/auth/business.manage'],
      metadata: {
        account_name: opts.accountName,
        location_name: opts.locationName,
        location_title: opts.locationTitle ?? null,
      },
    })
  }

  private async fetchAccounts(accessToken: string): Promise<GbpAccount[]> {
    const url = 'https://mybusinessaccountmanagement.googleapis.com/v1/accounts'
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!response.ok) {
      throw new ExternalServiceError('GoogleBusiness', response.status, await response.text())
    }
    const body = (await response.json()) as { accounts?: GbpAccount[] }
    return body.accounts ?? []
  }
}
