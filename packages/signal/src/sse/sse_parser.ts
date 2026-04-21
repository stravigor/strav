import type { SSEEvent, RawSSEMessage, SSEField } from './sse_types.ts'

// ---------------------------------------------------------------------------
// SSE Parsing (Stream -> Events)
// ---------------------------------------------------------------------------

/**
 * Parse a Server-Sent Events stream into structured events.
 *
 * Enhanced version that handles:
 * - Chunks split at arbitrary byte boundaries
 * - Multi-line data fields (concatenated with newlines)
 * - Event types, IDs, and retry hints
 * - Comments and keepalive messages
 * - Partial messages at stream end
 *
 * @example
 * const response = await fetch('/events')
 * for await (const event of parseSSE(response.body)) {
 *   console.log(event.event, event.data)
 * }
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>
): AsyncIterable<SSEEvent> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Split on double newline (message separator)
      const messages = buffer.split('\n\n')
      // Keep incomplete message in buffer
      buffer = messages.pop()!

      for (const message of messages) {
        const event = parseSSEMessage(message)
        if (event) yield event
      }
    }

    // Process remaining buffer
    if (buffer.trim()) {
      const event = parseSSEMessage(buffer)
      if (event) yield event
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Parse a single SSE message block into an event.
 */
function parseSSEMessage(message: string): SSEEvent | null {
  const raw: RawSSEMessage = { data: '' }
  const dataLines: string[] = []

  for (const line of message.split('\n')) {
    const field = parseSSEField(line)
    if (!field) continue

    switch (field.name) {
      case 'event':
        raw.event = field.value
        break
      case 'data':
        dataLines.push(field.value)
        break
      case 'id':
        raw.id = field.value
        break
      case 'retry':
        raw.retry = field.value
        break
      // Ignore other fields and comments
    }
  }

  // No data means no event
  if (dataLines.length === 0) return null

  // Join multi-line data
  const data = dataLines.join('\n')

  // Try to parse as JSON if it looks like JSON
  let parsedData: string | object = data
  if (data.startsWith('{') || data.startsWith('[')) {
    try {
      parsedData = JSON.parse(data)
    } catch {
      // Keep as string if not valid JSON
    }
  }

  const event: SSEEvent = { data: parsedData }
  if (raw.event) event.event = raw.event
  if (raw.id) event.id = raw.id
  if (raw.retry) event.retry = Number.parseInt(raw.retry, 10)

  return event
}

/**
 * Parse a single SSE field line.
 */
function parseSSEField(line: string): SSEField | null {
  // Empty line or comment
  if (!line || line.startsWith(':')) return null

  const colonIndex = line.indexOf(':')
  if (colonIndex === -1) return null

  const name = line.slice(0, colonIndex)
  let value = line.slice(colonIndex + 1)

  // Remove optional leading space
  if (value.startsWith(' ')) {
    value = value.slice(1)
  }

  return { name, value }
}

// ---------------------------------------------------------------------------
// SSE Formatting (Events -> Stream)
// ---------------------------------------------------------------------------

/**
 * Format an SSE event into a string for sending.
 *
 * @example
 * response.write(formatSSE({
 *   event: 'message',
 *   data: { text: 'Hello' },
 *   id: '123'
 * }))
 */
export function formatSSE(event: SSEEvent): string {
  const lines: string[] = []

  // Add event type if specified
  if (event.event) {
    lines.push(`event: ${event.event}`)
  }

  // Add ID if specified
  if (event.id) {
    lines.push(`id: ${event.id}`)
  }

  // Add retry hint if specified
  if (event.retry) {
    lines.push(`retry: ${event.retry}`)
  }

  // Format data (required)
  const dataStr = typeof event.data === 'string'
    ? event.data
    : JSON.stringify(event.data)

  // Split data by newlines for multi-line support
  for (const line of dataStr.split('\n')) {
    lines.push(`data: ${line}`)
  }

  // End with double newline
  return lines.join('\n') + '\n\n'
}

/**
 * Format a keepalive comment.
 */
export function formatSSEComment(text = ''): string {
  return `:${text}\n\n`
}

/**
 * Create a transform stream that formats objects into SSE.
 *
 * @example
 * const stream = new ReadableStream({
 *   async start(controller) {
 *     controller.enqueue({ event: 'ping', data: 'pong' })
 *   }
 * })
 * const sseStream = stream.pipeThrough(createSSEFormatter())
 */
export function createSSEFormatter(): TransformStream<SSEEvent, string> {
  return new TransformStream({
    transform(event, controller) {
      controller.enqueue(formatSSE(event))
    }
  })
}

/**
 * Create a transform stream that parses SSE text into events.
 *
 * @example
 * const textStream = response.body
 *   .pipeThrough(new TextDecoderStream())
 *   .pipeThrough(createSSEParser())
 *
 * for await (const event of textStream) {
 *   console.log(event)
 * }
 */
export function createSSEParser(): TransformStream<string, SSEEvent> {
  let buffer = ''

  return new TransformStream({
    transform(chunk, controller) {
      buffer += chunk

      const messages = buffer.split('\n\n')
      buffer = messages.pop()!

      for (const message of messages) {
        const event = parseSSEMessage(message)
        if (event) controller.enqueue(event)
      }
    },

    flush(controller) {
      if (buffer.trim()) {
        const event = parseSSEMessage(buffer)
        if (event) controller.enqueue(event)
      }
    }
  })
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Check if a request accepts SSE.
 */
export function acceptsSSE(request: Request): boolean {
  const accept = request.headers.get('accept') ?? ''
  return accept.includes('text/event-stream')
}

/**
 * Create SSE response headers.
 */
export function createSSEHeaders(options?: {
  cors?: string | string[]
  headers?: Record<string, string>
}): Headers {
  const headers = new Headers({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no', // Disable nginx buffering
    ...options?.headers
  })

  // Add CORS headers if specified
  if (options?.cors) {
    const origins = Array.isArray(options.cors)
      ? options.cors.join(', ')
      : options.cors
    headers.set('Access-Control-Allow-Origin', origins)
    headers.set('Access-Control-Allow-Credentials', 'true')
  }

  return headers
}