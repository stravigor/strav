import { PublishError } from '../errors.ts'
import type { Publisher } from '../publisher.ts'
import type { PublisherCredentialsData } from '../credentials/credentials.ts'
import type { PublishContent, PublishResult } from '../types.ts'

export interface MetaPublisherConfig {
  /** Override Graph API version. Default: 'v21.0'. */
  apiVersion?: string
}

/**
 * Meta Graph API publishers for Facebook Pages and Instagram.
 *
 * Both publishers share the same `meta` credential row (persisted by
 * MetaOAuth.exchangeAndPersist), differentiated only by which API call
 * they make. The credential's `accessToken` is the Page access token —
 * Meta's "long-lived page token" — which can publish to both surfaces
 * when the page is linked to an Instagram Business account.
 *
 * Credentials shape (set by MetaOAuth):
 *   - accessToken:              page access token (long-lived, ≈60 days)
 *   - metadata.page_id:         the Facebook Page ID
 *   - metadata.page_name:       display name (for UI)
 *   - metadata.ig_account_id:   Instagram Business account ID, or null
 *
 * Long-lived page tokens don't have a refresh token but do periodically
 * expire. Refresh() returns the existing token unchanged — the consent
 * flow needs to be re-run before expiry. Add a scheduled job that
 * checks expiresAt and pings the SME a week ahead.
 *
 * @see https://developers.facebook.com/docs/pages-api/posts/
 * @see https://developers.facebook.com/docs/instagram-platform/content-publishing/
 */

const DEFAULT_VERSION = 'v21.0'

abstract class BaseMetaPublisher {
  protected readonly apiVersion: string

  constructor(config?: MetaPublisherConfig) {
    this.apiVersion = config?.apiVersion ?? DEFAULT_VERSION
  }

  protected get baseUrl(): string {
    return `https://graph.facebook.com/${this.apiVersion}`
  }

  protected async post(url: string, params: Record<string, string>): Promise<unknown> {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    })
    const raw = await readJson(response)
    if (!response.ok) {
      throw new PublishError('meta', formatError(raw) ?? response.statusText, {
        status: response.status,
        raw,
      })
    }
    return raw
  }
}

export class FacebookPagePublisher extends BaseMetaPublisher implements Publisher {
  readonly name = 'facebook'

  async publish(
    credentials: PublisherCredentialsData,
    content: PublishContent
  ): Promise<PublishResult> {
    const pageId = String(credentials.metadata?.page_id ?? credentials.accountId)
    if (!pageId) throw new PublishError('facebook', 'credentials.metadata.page_id is required')

    const firstImage = content.media?.find(m => m.kind === 'image')

    if (firstImage) {
      // Photo post: posts the image with the body as the caption.
      const result = (await this.post(`${this.baseUrl}/${pageId}/photos`, {
        url: firstImage.url,
        caption: content.body,
        access_token: credentials.accessToken,
      })) as { id?: string; post_id?: string }
      const postId = result.post_id ?? result.id
      return {
        providerPostId: postId ?? undefined,
        url: postId ? `https://facebook.com/${postId}` : undefined,
        raw: result,
      }
    }

    // Text post (with optional link from callToAction).
    const params: Record<string, string> = {
      message: content.body,
      access_token: credentials.accessToken,
    }
    if (content.callToAction?.url) params.link = content.callToAction.url

    const result = (await this.post(`${this.baseUrl}/${pageId}/feed`, params)) as { id?: string }
    return {
      providerPostId: result.id,
      url: result.id ? `https://facebook.com/${result.id}` : undefined,
      raw: result,
    }
  }
}

export class InstagramPublisher extends BaseMetaPublisher implements Publisher {
  readonly name = 'instagram'

  async publish(
    credentials: PublisherCredentialsData,
    content: PublishContent
  ): Promise<PublishResult> {
    const igAccountId = credentials.metadata?.ig_account_id as string | undefined
    if (!igAccountId) {
      throw new PublishError(
        'instagram',
        'credentials.metadata.ig_account_id is required (link an Instagram Business account to this Page)'
      )
    }

    const firstImage = content.media?.find(m => m.kind === 'image')
    const firstVideo = content.media?.find(m => m.kind === 'video')

    // Two-step flow: create a media container, then publish it.
    // Reels (videos) use media_type='REELS'; single images omit media_type.
    let containerParams: Record<string, string>
    if (firstVideo) {
      containerParams = {
        media_type: 'REELS',
        video_url: firstVideo.url,
        caption: buildCaption(content),
        access_token: credentials.accessToken,
      }
    } else if (firstImage) {
      containerParams = {
        image_url: firstImage.url,
        caption: buildCaption(content),
        access_token: credentials.accessToken,
      }
    } else {
      throw new PublishError(
        'instagram',
        'Instagram requires at least one image or video — text-only posts are not supported'
      )
    }

    const container = (await this.post(
      `${this.baseUrl}/${igAccountId}/media`,
      containerParams
    )) as { id?: string }
    if (!container.id) {
      throw new PublishError('instagram', 'media container creation returned no id', {
        raw: container,
      })
    }

    const published = (await this.post(`${this.baseUrl}/${igAccountId}/media_publish`, {
      creation_id: container.id,
      access_token: credentials.accessToken,
    })) as { id?: string }

    return {
      providerPostId: published.id,
      url: published.id ? `https://www.instagram.com/p/${published.id}` : undefined,
      raw: { container, published },
    }
  }
}

/**
 * Re-export the FB Page publisher under the `meta` name for callers that
 * want a single "meta" platform key and only care about Facebook posting.
 * Most apps register all three (`facebook`, `instagram`, and any custom
 * combined wrapper) directly.
 */
export const MetaPublisher = FacebookPagePublisher

function buildCaption(content: PublishContent): string {
  const cta = content.callToAction?.url
  return cta ? `${content.body}\n\n${cta}` : content.body
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
