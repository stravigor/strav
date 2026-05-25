import { PublishError } from '../errors.ts'
import { refreshAccessToken } from '../oauth/oauth_helpers.ts'
import type { Publisher } from '../publisher.ts'
import type { PublisherCredentialsData } from '../credentials/credentials.ts'
import type {
  PublishContent,
  PublishResult,
  RefreshedTokens,
} from '../types.ts'

export interface GoogleBusinessProfilePublisherConfig {
  clientId: string
  clientSecret: string
  /** Override base URL for the v4 Posts endpoint. */
  baseUrl?: string
}

/**
 * Google Business Profile (Local Posts) publisher.
 *
 * Publishes to /v4/{accountName}/{locationName}/localPosts on the
 * mybusiness.googleapis.com host. The Posts endpoint stayed on v4 even
 * after the GBP API split (locations management moved to
 * mybusinessbusinessinformation.googleapis.com, accounts to
 * mybusinessaccountmanagement.googleapis.com).
 *
 * **GBP API access is gated.** Apps must request allowlist approval
 * from Google before /localPosts becomes callable:
 * https://developers.google.com/my-business/content/prereqs#api-access
 *
 * Credentials shape (set by GoogleBusinessOAuth.persistLocation):
 *   - accessToken:               short-lived (~1h)
 *   - refreshToken:              long-lived; auto-refreshed via refresh()
 *   - metadata.account_name:     'accounts/{accountId}'
 *   - metadata.location_name:    'locations/{locationId}'
 *   - metadata.location_title:   display name
 *
 * @see https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts
 */
export class GoogleBusinessProfilePublisher implements Publisher {
  readonly name = 'google_business'
  private readonly config: GoogleBusinessProfilePublisherConfig
  private readonly baseUrl: string

  constructor(config: GoogleBusinessProfilePublisherConfig) {
    this.config = config
    this.baseUrl = config.baseUrl ?? 'https://mybusiness.googleapis.com/v4'
  }

  async publish(
    credentials: PublisherCredentialsData,
    content: PublishContent
  ): Promise<PublishResult> {
    const accountName = String(credentials.metadata?.account_name ?? '')
    const locationName = String(credentials.metadata?.location_name ?? credentials.accountId)
    if (!accountName) {
      throw new PublishError('google_business', 'credentials.metadata.account_name is required')
    }
    if (!locationName) {
      throw new PublishError('google_business', 'credentials.metadata.location_name is required')
    }

    const body: Record<string, unknown> = {
      languageCode: content.language,
      summary: content.body,
      topicType: 'STANDARD',
    }

    const photo = content.media?.find(m => m.kind === 'image')
    if (photo) {
      body.media = [{ mediaFormat: 'PHOTO', sourceUrl: photo.url }]
    }

    if (content.callToAction?.url) {
      body.callToAction = {
        actionType: 'LEARN_MORE',
        url: content.callToAction.url,
      }
    }

    const url = `${this.baseUrl}/${accountName}/${locationName}/localPosts`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const raw = await readJson(response)
    if (!response.ok) {
      throw new PublishError('google_business', formatError(raw) ?? response.statusText, {
        status: response.status,
        raw,
      })
    }
    const post = raw as { name?: string; searchUrl?: string }
    return {
      providerPostId: post.name,
      url: post.searchUrl,
      raw,
    }
  }

  async refresh(credentials: PublisherCredentialsData): Promise<RefreshedTokens> {
    if (!credentials.refreshToken) {
      throw new PublishError(
        'google_business',
        'cannot refresh — no refresh_token stored; re-run the consent flow'
      )
    }
    const tokens = await refreshAccessToken({
      tokenUrl: 'https://oauth2.googleapis.com/token',
      config: {
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        // refreshAccessToken does not use redirectUrl, but the config
        // shape requires it.
        redirectUrl: '',
      },
      refreshToken: credentials.refreshToken,
      secretIn: 'post',
    })
    return {
      accessToken: tokens.accessToken,
      // Google does not rotate refresh tokens by default; leave undefined
      // so updateTokens preserves the existing one.
      refreshToken: tokens.refreshToken ?? undefined,
      expiresIn: tokens.expiresIn ?? undefined,
    }
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function formatError(raw: unknown): string | undefined {
  if (!raw) return undefined
  if (typeof raw === 'string') return raw
  if (typeof raw === 'object' && raw !== null) {
    const r = raw as Record<string, unknown>
    if (r.error && typeof r.error === 'object') {
      const e = r.error as Record<string, unknown>
      if (typeof e.message === 'string') return e.message
    }
    if (typeof r.message === 'string') return r.message
  }
  return undefined
}
