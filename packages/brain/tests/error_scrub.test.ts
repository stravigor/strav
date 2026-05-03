import { describe, expect, test } from 'bun:test'
import { scrubProviderError } from '../src/utils/error_scrub.ts'

describe('scrubProviderError', () => {
  test('redacts JSON bodies via @strav/kernel redact()', () => {
    const text = JSON.stringify({
      error: { type: 'auth_error', message: 'invalid api_key' },
      request: {
        headers: { authorization: 'Bearer sk-abc123', accept: 'application/json' },
      },
    })
    const out = scrubProviderError(text)
    const parsed = JSON.parse(out)
    expect(parsed.request.headers.authorization).toBe('[REDACTED]')
    expect(parsed.request.headers.accept).toBe('application/json')
    expect(parsed.error.type).toBe('auth_error')
  })

  test('scrubs Bearer tokens in plain text', () => {
    expect(scrubProviderError('Authorization: Bearer sk-abc123def456')).not.toContain(
      'sk-abc123def456'
    )
    expect(scrubProviderError('Authorization: Bearer sk-abc123def456')).toContain(
      'Bearer [REDACTED]'
    )
  })

  test('scrubs sk-prefixed API keys in plain text', () => {
    const text = 'Failed with key sk-proj-abc123def456 — try again'
    const out = scrubProviderError(text)
    expect(out).not.toContain('sk-proj-abc123def456')
    expect(out).toContain('sk-[REDACTED]')
  })

  test('scrubs api-key=value query strings', () => {
    const text = 'Request URL: https://api.example.com/v1/foo?api_key=abc123def&bar=baz'
    const out = scrubProviderError(text)
    expect(out).not.toContain('abc123def')
    expect(out).toContain('api_key=[REDACTED]')
    expect(out).toContain('bar=baz')
  })

  test('scrubs x-api-key header echoes', () => {
    const text = 'Request rejected: x-api-key: secret-abc-1234567890 not authorized'
    const out = scrubProviderError(text)
    expect(out).not.toContain('secret-abc-1234567890')
    expect(out.toLowerCase()).toContain('x-api-key=[redacted]')
  })

  test('passes benign text through unchanged', () => {
    const text = 'Service unavailable. Please retry in 30 seconds.'
    expect(scrubProviderError(text)).toBe(text)
  })

  test('handles empty / null / undefined input', () => {
    expect(scrubProviderError('')).toBe('')
    expect(scrubProviderError(null as any)).toBe('')
    expect(scrubProviderError(undefined as any)).toBe('')
  })

  test('JSON path catches even short field values that the regex would miss', () => {
    // A short key like 'abc' wouldn't match the {6,} regex floors, but
    // the JSON-path uses redact() which matches by KEY name.
    const text = JSON.stringify({ token: 'abc', other: 'x' })
    const parsed = JSON.parse(scrubProviderError(text))
    expect(parsed.token).toBe('[REDACTED]')
    expect(parsed.other).toBe('x')
  })
})
