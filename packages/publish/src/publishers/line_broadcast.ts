import { LineClient } from '@strav/line'
import type { LineMessage } from '@strav/line'
import { PublishError } from '../errors.ts'
import type { Publisher } from '../publisher.ts'
import type { PublisherCredentialsData } from '../credentials/credentials.ts'
import type { PublishContent, PublishResult } from '../types.ts'

/**
 * LINE Official Account broadcast publisher.
 *
 * Wraps @strav/line's LineClient.broadcast — sends the post to every
 * friend of the OA at once. Heavy fan-out; consider using
 * @strav/line/messaging.multicast() with a curated recipient list for
 * targeted updates instead.
 *
 * Credentials shape:
 *   - accessToken:   the LINE channel access token (long-lived)
 *   - metadata.channel_id:    the LINE channel ID (for display only)
 *
 * The credential is per-tenant because each SME has their own LINE OA
 * with its own channel access token. No OAuth refresh — channel access
 * tokens are issued long-lived from the LINE Developers console.
 *
 * For multilingual posts, send one publish() call per language. The
 * adapter constructs a single text message with the body; add media by
 * including `content.media` entries with public HTTPS URLs.
 *
 * @see https://developers.line.biz/en/reference/messaging-api/#send-broadcast-message
 */
export class LineBroadcastPublisher implements Publisher {
  readonly name = 'line_broadcast'

  async publish(
    credentials: PublisherCredentialsData,
    content: PublishContent
  ): Promise<PublishResult> {
    const client = new LineClient({ channelAccessToken: credentials.accessToken })

    const messages: LineMessage[] = []
    if (content.body) {
      messages.push({ type: 'text', text: content.body })
    }
    for (const media of content.media ?? []) {
      if (media.kind === 'image') {
        messages.push({
          type: 'image',
          originalContentUrl: media.url,
          // LINE requires a preview URL; reuse the original when none provided.
          previewImageUrl: media.url,
        })
      } else if (media.kind === 'video') {
        messages.push({
          type: 'video',
          originalContentUrl: media.url,
          previewImageUrl: media.url,
        })
      }
    }
    if (messages.length === 0) {
      throw new PublishError('line_broadcast', 'content must include body or media')
    }
    // LINE allows at most 5 messages per call; truncate to be safe.
    const truncated = messages.slice(0, 5)

    const raw = await client.broadcast(truncated)
    return { raw }
  }
}
