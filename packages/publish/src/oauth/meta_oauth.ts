import { ExternalServiceError } from '@strav/kernel'
import PublisherCredentials from '../credentials/credentials.ts'
import type { PublisherCredentialsData } from '../credentials/credentials.ts'
import {
  buildAuthUrl,
  exchangeCode,
  type OAuthClientConfig,
} from './oauth_helpers.ts'

export interface MetaOAuthConfig extends OAuthClientConfig {
  /** Override Graph API version. Default: 'v21.0'. */
  apiVersion?: string
}

interface FacebookPage {
  id: string
  name: string
  access_token: string
  /** Connected Instagram account, if any. */
  instagram_business_account?: { id: string }
}

/**
 * OAuth + account-selection flow for Meta (Facebook Pages + Instagram).
 *
 * The consent flow has two phases:
 *
 *   1. `authUrl()` → user lands on Facebook, picks which Page(s) the
 *      app may manage, and is bounced back to your callback with `?code=`.
 *   2. `exchangeAndPersist()` → exchanges the code for a user access
 *      token, calls `/me/accounts` to enumerate Pages, then persists ONE
 *      PublisherCredentials row per Page (each row stores the page access
 *      token, since Page tokens are what you actually publish with).
 *
 * Long-lived page tokens (≈60d) are not auto-refreshed — see
 * https://developers.facebook.com/docs/facebook-login/access-tokens/refreshing/
 * for the upgrade path. MetaPublisher's `refresh()` returns the existing
 * token unchanged; the SME has to re-consent before expiry.
 *
 * Scopes you typically need:
 *   - `pages_show_list`         enumerate Pages
 *   - `pages_read_engagement`   read insights
 *   - `pages_manage_posts`      publish posts
 *   - `instagram_basic`         enumerate IG accounts
 *   - `instagram_content_publish` publish to IG
 */
export class MetaOAuth {
  private readonly config: MetaOAuthConfig
  private readonly apiVersion: string

  constructor(config: MetaOAuthConfig) {
    this.config = config
    this.apiVersion = config.apiVersion ?? 'v21.0'
  }

  /** Build the consent URL. Persist `state` server-side. */
  authUrl(opts: { state: string; scopes?: string[] }): string {
    const scopes = opts.scopes ?? [
      'pages_show_list',
      'pages_read_engagement',
      'pages_manage_posts',
      'instagram_basic',
      'instagram_content_publish',
    ]
    return buildAuthUrl({
      authUrl: `https://www.facebook.com/${this.apiVersion}/dialog/oauth`,
      config: this.config,
      scopes,
      state: opts.state,
    })
  }

  /**
   * Exchange the OAuth code, list the user's Pages, and persist one
   * credentials row per Page for the tenant.
   *
   * Returns the list of created credentials so the UI can show "Pages
   * connected" feedback. Empty array means the user granted access but
   * has no Pages — surface that explicitly.
   */
  async exchangeAndPersist(opts: {
    tenantId: string | number
    code: string
  }): Promise<PublisherCredentialsData[]> {
    const userToken = await exchangeCode({
      tokenUrl: `https://graph.facebook.com/${this.apiVersion}/oauth/access_token`,
      config: this.config,
      code: opts.code,
      secretIn: 'post',
    })

    const pages = await this.fetchPages(userToken.accessToken)

    const persisted: PublisherCredentialsData[] = []
    for (const page of pages) {
      const credential = await PublisherCredentials.upsert({
        tenantId: opts.tenantId,
        platform: 'meta',
        accountId: page.id,
        accessToken: page.access_token,
        // Page tokens don't carry a refresh token — long-lived but
        // ultimately expiring. Leave refreshToken null.
        refreshToken: null,
        expiresAt: userToken.expiresIn
          ? new Date(Date.now() + userToken.expiresIn * 1000)
          : null,
        scopes: userToken.scope?.split(/[\s,]+/) ?? null,
        metadata: {
          page_id: page.id,
          page_name: page.name,
          ig_account_id: page.instagram_business_account?.id ?? null,
        },
      })
      persisted.push(credential)
    }
    return persisted
  }

  private async fetchPages(userAccessToken: string): Promise<FacebookPage[]> {
    const url = `https://graph.facebook.com/${this.apiVersion}/me/accounts?fields=id,name,access_token,instagram_business_account&access_token=${encodeURIComponent(userAccessToken)}`
    const response = await fetch(url)
    if (!response.ok) {
      throw new ExternalServiceError('Meta', response.status, await response.text())
    }
    const body = (await response.json()) as { data: FacebookPage[] }
    return body.data ?? []
  }
}
