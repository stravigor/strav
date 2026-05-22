import type {
  EventStore,
  StreamId,
  EventId,
} from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/** Options for {@link MemoryEventStore}. */
export interface MemoryEventStoreOptions {
  /**
   * Maximum number of events retained per stream. Once exceeded, the oldest
   * events for that stream are evicted. Default: `1000`.
   */
  maxEventsPerStream?: number
}

interface StoredEvent {
  streamId: StreamId
  message: JSONRPCMessage
}

/**
 * In-memory {@link EventStore} for Streamable-HTTP resumability.
 *
 * When passed to `mountHttpTransport({ eventStore })`, the SDK assigns every
 * server→client message an `id`; a client that drops its SSE connection may
 * reconnect with `Last-Event-ID` and have the missed messages replayed.
 *
 * This reference implementation keeps events in process memory — it is
 * single-node only. A multi-node deployment must supply an `EventStore`
 * backed by shared storage (e.g. Redis Streams) so a client can resume
 * against whichever node it reconnects to.
 */
export class MemoryEventStore implements EventStore {
  private readonly events = new Map<EventId, StoredEvent>()
  private order: EventId[] = []
  private seq = 0
  private readonly maxPerStream: number

  constructor(options?: MemoryEventStoreOptions) {
    this.maxPerStream = options?.maxEventsPerStream ?? 1000
  }

  /** Store an event and return its generated, monotonically-ordered id. */
  async storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
    const eventId = `${streamId}::${(++this.seq).toString(36)}`
    this.events.set(eventId, { streamId, message })
    this.order.push(eventId)
    this.evict(streamId)
    return eventId
  }

  /** Resolve the stream an event belongs to. */
  async getStreamIdForEventId(eventId: EventId): Promise<StreamId | undefined> {
    return this.events.get(eventId)?.streamId
  }

  /**
   * Replay every event recorded after `lastEventId` on the same stream.
   * Returns the stream id, or an empty string when `lastEventId` is unknown
   * (e.g. already evicted) — the SDK then treats the reconnection as fresh.
   */
  async replayEventsAfter(
    lastEventId: EventId,
    { send }: { send: (eventId: EventId, message: JSONRPCMessage) => Promise<void> }
  ): Promise<StreamId> {
    const anchor = this.events.get(lastEventId)
    if (!anchor) return ''

    const startIndex = this.order.indexOf(lastEventId)
    for (let i = startIndex + 1; i < this.order.length; i++) {
      const id = this.order[i]!
      const event = this.events.get(id)
      if (event && event.streamId === anchor.streamId) {
        await send(id, event.message)
      }
    }
    return anchor.streamId
  }

  /** Drop every stored event. Intended for tests / shutdown. */
  clear(): void {
    this.events.clear()
    this.order = []
  }

  private evict(streamId: StreamId): void {
    const streamEventIds = this.order.filter(
      id => this.events.get(id)?.streamId === streamId
    )
    if (streamEventIds.length <= this.maxPerStream) return

    const stale = streamEventIds.slice(0, streamEventIds.length - this.maxPerStream)
    for (const id of stale) {
      this.events.delete(id)
      const index = this.order.indexOf(id)
      if (index !== -1) this.order.splice(index, 1)
    }
  }
}
