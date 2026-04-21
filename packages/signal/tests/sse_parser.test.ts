import { describe, expect, test } from 'bun:test'
import {
  parseSSE,
  formatSSE,
  formatSSEComment,
  createSSEFormatter,
  createSSEParser,
  acceptsSSE,
  createSSEHeaders,
} from '../src/sse/sse_parser.ts'

describe('SSE Parser', () => {
  describe('parseSSE', () => {
    test('parses simple event with data', async () => {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode('data: hello\n\n'))
          controller.close()
        }
      })

      const events = []
      for await (const event of parseSSE(stream)) {
        events.push(event)
      }

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({ data: 'hello' })
    })

    test('parses event with type', async () => {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode('event: message\ndata: hello\n\n'))
          controller.close()
        }
      })

      const events = []
      for await (const event of parseSSE(stream)) {
        events.push(event)
      }

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({ event: 'message', data: 'hello' })
    })

    test('parses event with id and retry', async () => {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode('id: 123\nretry: 5000\ndata: test\n\n'))
          controller.close()
        }
      })

      const events = []
      for await (const event of parseSSE(stream)) {
        events.push(event)
      }

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({ data: 'test', id: '123', retry: 5000 })
    })

    test('parses multi-line data', async () => {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode('data: line 1\ndata: line 2\ndata: line 3\n\n'))
          controller.close()
        }
      })

      const events = []
      for await (const event of parseSSE(stream)) {
        events.push(event)
      }

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({ data: 'line 1\nline 2\nline 3' })
    })

    test('parses JSON data', async () => {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode('data: {"message":"hello","count":42}\n\n'))
          controller.close()
        }
      })

      const events = []
      for await (const event of parseSSE(stream)) {
        events.push(event)
      }

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({ data: { message: 'hello', count: 42 } })
    })

    test('handles chunks split across boundaries', async () => {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode('da'))
          controller.enqueue(encoder.encode('ta: hel'))
          controller.enqueue(encoder.encode('lo\n\ndata:'))
          controller.enqueue(encoder.encode(' world\n\n'))
          controller.close()
        }
      })

      const events = []
      for await (const event of parseSSE(stream)) {
        events.push(event)
      }

      expect(events).toHaveLength(2)
      expect(events[0]).toEqual({ data: 'hello' })
      expect(events[1]).toEqual({ data: 'world' })
    })

    test('ignores comments', async () => {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode(': this is a comment\ndata: hello\n\n'))
          controller.close()
        }
      })

      const events = []
      for await (const event of parseSSE(stream)) {
        events.push(event)
      }

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({ data: 'hello' })
    })

    test('handles empty data field', async () => {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode('data:\ndata: \ndata: text\n\n'))
          controller.close()
        }
      })

      const events = []
      for await (const event of parseSSE(stream)) {
        events.push(event)
      }

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({ data: '\n\ntext' })
    })

    test('handles trailing data without double newline', async () => {
      const stream = new ReadableStream({
        start(controller) {
          const encoder = new TextEncoder()
          controller.enqueue(encoder.encode('data: incomplete'))
          controller.close()
        }
      })

      const events = []
      for await (const event of parseSSE(stream)) {
        events.push(event)
      }

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({ data: 'incomplete' })
    })
  })

  describe('formatSSE', () => {
    test('formats simple data', () => {
      const result = formatSSE({ data: 'hello' })
      expect(result).toBe('data: hello\n\n')
    })

    test('formats with event type', () => {
      const result = formatSSE({ event: 'message', data: 'hello' })
      expect(result).toBe('event: message\ndata: hello\n\n')
    })

    test('formats with id and retry', () => {
      const result = formatSSE({ data: 'test', id: '123', retry: 5000 })
      expect(result).toBe('id: 123\nretry: 5000\ndata: test\n\n')
    })

    test('formats object data as JSON', () => {
      const result = formatSSE({ data: { message: 'hello', count: 42 } })
      expect(result).toBe('data: {"message":"hello","count":42}\n\n')
    })

    test('formats multi-line string data', () => {
      const result = formatSSE({ data: 'line 1\nline 2\nline 3' })
      expect(result).toBe('data: line 1\ndata: line 2\ndata: line 3\n\n')
    })
  })

  describe('formatSSEComment', () => {
    test('formats comment with text', () => {
      const result = formatSSEComment('keepalive')
      expect(result).toBe(':keepalive\n\n')
    })

    test('formats empty comment', () => {
      const result = formatSSEComment()
      expect(result).toBe(':\n\n')
    })
  })

  describe('createSSEFormatter', () => {
    test('transforms event objects to SSE strings', async () => {
      const input = new ReadableStream({
        start(controller) {
          controller.enqueue({ event: 'message', data: 'hello' })
          controller.enqueue({ data: { count: 42 } })
          controller.close()
        }
      })

      const output = input.pipeThrough(createSSEFormatter())
      const reader = output.getReader()

      const chunks: string[] = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
      }

      expect(chunks).toHaveLength(2)
      expect(chunks[0]).toBe('event: message\ndata: hello\n\n')
      expect(chunks[1]).toBe('data: {"count":42}\n\n')
    })
  })

  describe('createSSEParser', () => {
    test('transforms SSE text to event objects', async () => {
      const input = new ReadableStream({
        start(controller) {
          controller.enqueue('event: message\ndata: hello\n\n')
          controller.enqueue('data: {"count":42}\n\n')
          controller.close()
        }
      })

      const output = input.pipeThrough(createSSEParser())
      const reader = output.getReader()

      const events = []
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        events.push(value)
      }

      expect(events).toHaveLength(2)
      expect(events[0]).toEqual({ event: 'message', data: 'hello' })
      expect(events[1]).toEqual({ data: { count: 42 } })
    })
  })

  describe('acceptsSSE', () => {
    test('returns true when accept header includes text/event-stream', () => {
      const request = new Request('http://example.com', {
        headers: { Accept: 'text/event-stream' }
      })
      expect(acceptsSSE(request)).toBe(true)
    })

    test('returns true when accept header contains text/event-stream among others', () => {
      const request = new Request('http://example.com', {
        headers: { Accept: 'text/html, text/event-stream, application/json' }
      })
      expect(acceptsSSE(request)).toBe(true)
    })

    test('returns false when accept header does not include text/event-stream', () => {
      const request = new Request('http://example.com', {
        headers: { Accept: 'application/json' }
      })
      expect(acceptsSSE(request)).toBe(false)
    })

    test('returns false when no accept header', () => {
      const request = new Request('http://example.com')
      expect(acceptsSSE(request)).toBe(false)
    })
  })

  describe('createSSEHeaders', () => {
    test('creates basic SSE headers', () => {
      const headers = createSSEHeaders()
      expect(headers.get('Content-Type')).toBe('text/event-stream')
      expect(headers.get('Cache-Control')).toBe('no-cache')
      expect(headers.get('Connection')).toBe('keep-alive')
      expect(headers.get('X-Accel-Buffering')).toBe('no')
    })

    test('adds CORS headers when specified as string', () => {
      const headers = createSSEHeaders({ cors: 'https://example.com' })
      expect(headers.get('Access-Control-Allow-Origin')).toBe('https://example.com')
      expect(headers.get('Access-Control-Allow-Credentials')).toBe('true')
    })

    test('adds CORS headers when specified as array', () => {
      const headers = createSSEHeaders({
        cors: ['https://app1.com', 'https://app2.com']
      })
      expect(headers.get('Access-Control-Allow-Origin')).toBe('https://app1.com, https://app2.com')
      expect(headers.get('Access-Control-Allow-Credentials')).toBe('true')
    })

    test('merges custom headers', () => {
      const headers = createSSEHeaders({
        headers: { 'X-Custom': 'value' }
      })
      expect(headers.get('X-Custom')).toBe('value')
      expect(headers.get('Content-Type')).toBe('text/event-stream')
    })
  })
})