/**
 * Built-in publisher names. Apps can register custom publishers under any
 * string identifier; this union is the discriminator for the four
 * adapters that ship in @strav/publish.
 */
export type PublisherName =
  | 'google_business'
  | 'meta'
  | 'wordpress'
  | 'line_broadcast'

/**
 * BCP-47 language tag. Each `publish()` call carries one language —
 * multi-language fan-out is the caller's responsibility (typically driven
 * by @strav/durable so each language × platform combination is its own
 * retryable step).
 */
export type LanguageTag = string

/**
 * Canonical content shape passed to a publisher.
 *
 * Each publisher translates this into a platform-specific payload. Fields
 * that don't map cleanly to a given platform are dropped silently (e.g.,
 * Instagram has no concept of a separate `title`; WordPress doesn't honour
 * `callToAction`). Publishers document their own field handling.
 */
export interface PublishContent {
  /** BCP-47 language of this content. Drives platform language tags. */
  language: LanguageTag
  /** Short title — used by WordPress and as a fallback caption elsewhere. */
  title?: string
  /** Main body. Plain text or platform-native markup. Required. */
  body: string
  /** Zero or more media attachments. */
  media?: PublishMedia[]
  /** Optional call-to-action shown by platforms that support buttons (GBP). */
  callToAction?: { label?: string; url: string }
  /**
   * Optional geo for location-aware platforms (GBP events). Most apps
   * leave this blank — the platform infers from the credential's
   * configured location.
   */
  location?: { latitude: number; longitude: number; name?: string }
  /**
   * Optional explicit schedule. Few platforms support this natively;
   * publishers that don't surface a scheduling API throw if set.
   */
  scheduledAt?: Date
}

export type PublishMediaKind = 'image' | 'video'

export interface PublishMedia {
  kind: PublishMediaKind
  /**
   * Public HTTPS URL the destination platform can fetch. Required for all
   * platforms; @strav/publish does not host media itself.
   */
  url: string
  /** Width / height in pixels — required by some platforms (GBP) for upload. */
  width?: number
  height?: number
  /** Per-media caption / alt text. */
  caption?: string
  /** MIME type. Required when the URL doesn't expose it via headers. */
  contentType?: string
}

/**
 * Result returned by a successful publish call.
 *
 * `providerPostId` is the destination platform's stable identifier for
 * the published post (Google `localPosts/...`, Meta `{page_id}_{post_id}`,
 * WordPress post ID, LINE broadcast request ID, etc.). `url` is the
 * canonical public link to the post when the platform exposes one.
 */
export interface PublishResult {
  providerPostId?: string
  url?: string
  /** Original platform response for callers that need additional fields. */
  raw?: unknown
}

/**
 * Refreshed OAuth tokens returned by a publisher's refresh hook.
 *
 * The credentials store persists the new access token (and refresh token,
 * if rotated) and updates `expiresAt`.
 */
export interface RefreshedTokens {
  accessToken: string
  /** New refresh token if the provider rotated it; otherwise leave undefined. */
  refreshToken?: string
  /** Seconds from now until the new access token expires. */
  expiresIn?: number
}
