import { PublishError } from '../errors.ts'
import type { Publisher } from '../publisher.ts'
import type { PublisherCredentialsData } from '../credentials/credentials.ts'
import type { PublishContent, PublishMedia, PublishResult } from '../types.ts'

export interface WordPressPublisherConfig {
  /**
   * Override the WP REST namespace if the site uses a non-default prefix.
   * Default: '/wp-json/wp/v2'.
   */
  apiPath?: string
}

/**
 * WordPress REST API publisher.
 *
 * Authentication: Application Passwords (HTTP Basic) — the long-lived
 * username+app-password pair the SME generated in Users → Profile.
 * Distinct from a regular login password; passes through this package
 * encrypted at rest via PublisherCredentials.
 *
 * Credentials shape:
 *   - accessToken:    the application password
 *   - metadata.site_url:   `https://example.com` (no trailing slash)
 *   - metadata.username:   WordPress username (used for Basic auth)
 *   - metadata.featured_post_status:  optional, defaults to 'publish'
 *
 * No refresh — Application Passwords are long-lived and revoked manually
 * from wp-admin.
 *
 * @see https://developer.wordpress.org/rest-api/reference/posts/
 * @see https://developer.wordpress.org/rest-api/reference/media/
 */
export class WordPressPublisher implements Publisher {
  readonly name = 'wordpress'
  private readonly apiPath: string

  constructor(config?: WordPressPublisherConfig) {
    this.apiPath = config?.apiPath ?? '/wp-json/wp/v2'
  }

  async publish(
    credentials: PublisherCredentialsData,
    content: PublishContent
  ): Promise<PublishResult> {
    const siteUrl = String(credentials.metadata?.site_url ?? '')
    const username = String(credentials.metadata?.username ?? '')
    if (!siteUrl) throw new PublishError('wordpress', 'credentials.metadata.site_url is required')
    if (!username) throw new PublishError('wordpress', 'credentials.metadata.username is required')

    const basicAuth = Buffer.from(`${username}:${credentials.accessToken}`, 'utf8').toString('base64')
    const authHeader = `Basic ${basicAuth}`
    const status = String(credentials.metadata?.featured_post_status ?? 'publish')

    // Upload featured image (first image in media[]) before creating the
    // post so we have a media ID to attach. WP doesn't accept URL refs;
    // the file has to be fetched and re-uploaded.
    let featuredMediaId: number | undefined
    const firstImage = content.media?.find(m => m.kind === 'image')
    if (firstImage) {
      featuredMediaId = await this.uploadMedia(siteUrl, authHeader, firstImage)
    }

    const body = {
      title: content.title ?? deriveTitle(content.body),
      content: content.body,
      status,
      featured_media: featuredMediaId,
      // WordPress doesn't natively use BCP-47 language tags on posts, but
      // multilingual plugins (WPML, Polylang) read this meta field.
      meta: { strav_language: content.language },
    }

    const url = `${siteUrl}${this.apiPath}/posts`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(stripUndefined(body)),
    })
    const raw = await readJson(response)
    if (!response.ok) {
      throw new PublishError('wordpress', formatError(raw) ?? response.statusText, {
        status: response.status,
        raw,
      })
    }
    const post = raw as { id: number; link: string }
    return { providerPostId: String(post.id), url: post.link, raw }
  }

  /**
   * Fetch the media from its public URL, upload to WP, and return the
   * new media ID. WP only accepts uploads as multipart bodies — URL
   * references aren't supported by the REST API.
   */
  private async uploadMedia(
    siteUrl: string,
    authHeader: string,
    media: PublishMedia
  ): Promise<number> {
    const fileResponse = await fetch(media.url)
    if (!fileResponse.ok) {
      throw new PublishError('wordpress', `Failed to fetch media at ${media.url}`, {
        status: fileResponse.status,
      })
    }
    const blob = await fileResponse.blob()
    const filename = filenameFromUrl(media.url)
    const contentType = media.contentType ?? blob.type ?? 'application/octet-stream'

    const upload = await fetch(`${siteUrl}${this.apiPath}/media`, {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Disposition': `attachment; filename="${filename}"`,
        'Content-Type': contentType,
      },
      body: blob,
    })
    const raw = await readJson(upload)
    if (!upload.ok) {
      throw new PublishError('wordpress', formatError(raw) ?? 'media upload failed', {
        status: upload.status,
        raw,
      })
    }
    return (raw as { id: number }).id
  }
}

function deriveTitle(body: string): string {
  const first = body.split('\n').find(line => line.trim().length > 0) ?? ''
  return first.length > 80 ? first.slice(0, 77) + '…' : first
}

function filenameFromUrl(url: string): string {
  try {
    const u = new URL(url)
    const segments = u.pathname.split('/')
    const last = segments[segments.length - 1]
    return last && last.includes('.') ? last : 'upload.bin'
  } catch {
    return 'upload.bin'
  }
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v
  }
  return out as T
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
    if (typeof r.message === 'string') return r.message
  }
  return undefined
}
