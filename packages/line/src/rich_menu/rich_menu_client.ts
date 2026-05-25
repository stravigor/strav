import { ConfigurationError, ExternalServiceError } from '@strav/kernel'
import {
  RICH_MENU_LIMITS,
  type CreateRichMenuRequest,
  type RichMenuResponse,
} from './types.ts'

export interface RichMenuClientConfig {
  channelAccessToken: string
  baseUrl?: string
  dataBaseUrl?: string
}

/**
 * Client for the LINE Rich Menu management API.
 *
 * The Rich Menu API spans two hosts: api.line.me for the metadata CRUD
 * (create, list, delete, link/unlink, default) and api-data.line.me for
 * the image upload/download endpoints. Both are wired here behind the same
 * configuration so callers don't think about it.
 *
 * Image uploads accept either a Uint8Array (typical when reading from FS
 * or S3) or a Blob (typical from a multipart upload handler). Content
 * type must be 'image/png' or 'image/jpeg'; LINE rejects everything else.
 *
 * @see https://developers.line.biz/en/reference/messaging-api/#rich-menu
 */
export class RichMenuClient {
  private readonly channelAccessToken: string
  private readonly baseUrl: string
  private readonly dataBaseUrl: string

  constructor(config: RichMenuClientConfig) {
    if (!config.channelAccessToken) {
      throw new ConfigurationError('RichMenuClient requires channelAccessToken')
    }
    this.channelAccessToken = config.channelAccessToken
    this.baseUrl = config.baseUrl ?? 'https://api.line.me'
    this.dataBaseUrl = config.dataBaseUrl ?? 'https://api-data.line.me'
  }

  /** Create a rich menu and return its ID. */
  async create(request: CreateRichMenuRequest): Promise<string> {
    this.validate(request)
    const result = (await this.json('POST', '/v2/bot/richmenu', request)) as {
      richMenuId: string
    }
    return result.richMenuId
  }

  /** Upload the rich menu image. PNG or JPEG, ≤ 1MB. */
  async uploadImage(
    richMenuId: string,
    image: Uint8Array | Blob,
    contentType: 'image/png' | 'image/jpeg'
  ): Promise<void> {
    const bytes = image instanceof Blob ? image.size : image.byteLength
    if (bytes > RICH_MENU_LIMITS.IMAGE_BYTES) {
      throw new ExternalServiceError(
        'LINE',
        400,
        `Rich menu image is ${bytes} bytes (max ${RICH_MENU_LIMITS.IMAGE_BYTES})`
      )
    }
    const url = `${this.dataBaseUrl}/v2/bot/richmenu/${encodeURIComponent(richMenuId)}/content`
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.channelAccessToken}`,
        'Content-Type': contentType,
      },
      body: image instanceof Blob ? image : new Blob([image], { type: contentType }),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new ExternalServiceError('LINE', response.status, text || 'rich menu image upload failed')
    }
  }

  /** Fetch a single rich menu's structure. */
  async get(richMenuId: string): Promise<RichMenuResponse> {
    return (await this.json(
      'GET',
      `/v2/bot/richmenu/${encodeURIComponent(richMenuId)}`,
      null
    )) as RichMenuResponse
  }

  /** List every rich menu attached to the OA. */
  async list(): Promise<RichMenuResponse[]> {
    const result = (await this.json('GET', '/v2/bot/richmenu/list', null)) as {
      richmenus: RichMenuResponse[]
    }
    return result.richmenus
  }

  /** Delete a rich menu by ID. */
  async delete(richMenuId: string): Promise<void> {
    await this.json('DELETE', `/v2/bot/richmenu/${encodeURIComponent(richMenuId)}`, null)
  }

  /** Set the default rich menu shown to every friend of the OA. */
  async setDefault(richMenuId: string): Promise<void> {
    await this.json('POST', `/v2/bot/user/all/richmenu/${encodeURIComponent(richMenuId)}`, null)
  }

  /** Get the current default rich menu ID. Returns null if none is set. */
  async getDefault(): Promise<string | null> {
    const url = `${this.baseUrl}/v2/bot/user/all/richmenu`
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${this.channelAccessToken}` },
    })
    if (response.status === 404) return null
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new ExternalServiceError('LINE', response.status, text || 'getDefault failed')
    }
    const body = (await response.json()) as { richMenuId: string }
    return body.richMenuId
  }

  /** Cancel the default rich menu (revert all friends to no menu). */
  async clearDefault(): Promise<void> {
    await this.json('DELETE', '/v2/bot/user/all/richmenu', null)
  }

  /** Attach a rich menu to a specific user (overrides the default for that user). */
  async linkToUser(userId: string, richMenuId: string): Promise<void> {
    await this.json(
      'POST',
      `/v2/bot/user/${encodeURIComponent(userId)}/richmenu/${encodeURIComponent(richMenuId)}`,
      null
    )
  }

  /** Remove the per-user rich menu (user reverts to the default, if any). */
  async unlinkFromUser(userId: string): Promise<void> {
    await this.json('DELETE', `/v2/bot/user/${encodeURIComponent(userId)}/richmenu`, null)
  }

  /** Bulk-attach a rich menu to many users (max 500 per call per LINE docs). */
  async bulkLink(userIds: string[], richMenuId: string): Promise<void> {
    if (userIds.length === 0) {
      throw new ExternalServiceError('LINE', 400, 'bulkLink requires at least one userId')
    }
    await this.json('POST', '/v2/bot/richmenu/bulk/link', { richMenuId, userIds })
  }

  /** Bulk-detach the per-user rich menu from many users. */
  async bulkUnlink(userIds: string[]): Promise<void> {
    if (userIds.length === 0) {
      throw new ExternalServiceError('LINE', 400, 'bulkUnlink requires at least one userId')
    }
    await this.json('POST', '/v2/bot/richmenu/bulk/unlink', { userIds })
  }

  private validate(request: CreateRichMenuRequest): void {
    if (request.name.length > RICH_MENU_LIMITS.NAME_MAX) {
      throw new ExternalServiceError(
        'LINE',
        400,
        `Rich menu name is ${request.name.length} chars (max ${RICH_MENU_LIMITS.NAME_MAX})`
      )
    }
    if (request.chatBarText.length > RICH_MENU_LIMITS.CHAT_BAR_TEXT_MAX) {
      throw new ExternalServiceError(
        'LINE',
        400,
        `chatBarText is ${request.chatBarText.length} chars (max ${RICH_MENU_LIMITS.CHAT_BAR_TEXT_MAX})`
      )
    }
    if (request.areas.length === 0) {
      throw new ExternalServiceError('LINE', 400, 'Rich menu requires at least one area')
    }
    for (const [index, area] of request.areas.entries()) {
      const { x, y, width, height } = area.bounds
      if (
        x < 0 ||
        y < 0 ||
        width <= 0 ||
        height <= 0 ||
        x + width > request.size.width ||
        y + height > request.size.height
      ) {
        throw new ExternalServiceError(
          'LINE',
          400,
          `Area #${index} bounds (${x},${y},${width}×${height}) fall outside ${request.size.width}×${request.size.height}`
        )
      }
    }
  }

  private async json(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: unknown
  ): Promise<unknown> {
    const url = `${this.baseUrl}${path}`
    const init: RequestInit = {
      method,
      headers: {
        Authorization: `Bearer ${this.channelAccessToken}`,
        ...(body !== null ? { 'Content-Type': 'application/json' } : {}),
      },
    }
    if (body !== null) {
      init.body = JSON.stringify(body)
    }

    const response = await fetch(url, init)
    const text = await response.text()
    const raw: unknown = text ? safeJson(text) : undefined
    if (!response.ok) {
      throw new ExternalServiceError('LINE', response.status, formatError(raw) ?? text)
    }
    return raw
  }
}

function safeJson(text: string): unknown {
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
    const message = (raw as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  return JSON.stringify(raw)
}
