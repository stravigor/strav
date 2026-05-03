import { describe, expect, test } from 'bun:test'
import { resolveCorsConfig, resolveOrigin } from '../src/http/cors.ts'

describe('resolveCorsConfig defaults', () => {
  test('default origin is false (CORS disabled until opted in)', () => {
    const config = resolveCorsConfig()
    expect(config.origin).toBe(false)
  })

  test('explicit options override the default', () => {
    const config = resolveCorsConfig({ origin: 'https://app.example.com' })
    expect(config.origin).toBe('https://app.example.com')
  })
})

describe('resolveOrigin', () => {
  test('returns null when origin is false (strict default)', () => {
    const config = resolveCorsConfig() // origin: false
    expect(resolveOrigin(config, 'https://app.example.com')).toBeNull()
    expect(resolveOrigin(config, null)).toBeNull()
  })

  test("origin: '*' allows any origin", () => {
    const config = resolveCorsConfig({ origin: '*' })
    expect(resolveOrigin(config, 'https://anywhere.example')).toBe('*')
  })

  test("origin: '*' + credentials reflects the request origin", () => {
    const config = resolveCorsConfig({ origin: '*', credentials: true })
    expect(resolveOrigin(config, 'https://anywhere.example')).toBe('https://anywhere.example')
  })

  test('exact-match string origin', () => {
    const config = resolveCorsConfig({ origin: 'https://app.example.com' })
    expect(resolveOrigin(config, 'https://app.example.com')).toBe('https://app.example.com')
    expect(resolveOrigin(config, 'https://other.example.com')).toBeNull()
  })

  test('allow-list array', () => {
    const config = resolveCorsConfig({
      origin: ['https://a.example.com', 'https://b.example.com'],
    })
    expect(resolveOrigin(config, 'https://a.example.com')).toBe('https://a.example.com')
    expect(resolveOrigin(config, 'https://c.example.com')).toBeNull()
  })

  test('regex origin matcher', () => {
    const config = resolveCorsConfig({ origin: /^https:\/\/[a-z]+\.example\.com$/ })
    expect(resolveOrigin(config, 'https://app.example.com')).toBe('https://app.example.com')
    expect(resolveOrigin(config, 'https://attacker.com')).toBeNull()
  })

  test('callback origin matcher', () => {
    const config = resolveCorsConfig({
      origin: (o: string) => o.endsWith('.example.com'),
    })
    expect(resolveOrigin(config, 'https://app.example.com')).toBe('https://app.example.com')
    expect(resolveOrigin(config, 'https://other.com')).toBeNull()
  })

  test('rejects origins longer than 253 chars before regex match (ReDoS guard)', () => {
    // Pathological input that, against a naive `(a+)+$` regex, would
    // exhibit catastrophic backtracking. The length bound rejects it
    // before the regex is even tested.
    const evilRegex = /^(a+)+$/
    const config = resolveCorsConfig({ origin: evilRegex })
    const long = 'a'.repeat(500)
    expect(resolveOrigin(config, long)).toBeNull()
  })

  test('rejects origins longer than 253 chars even for allow-list arrays', () => {
    const config = resolveCorsConfig({ origin: ['https://app.example.com'] })
    const long = 'https://' + 'a'.repeat(300) + '.example.com'
    expect(resolveOrigin(config, long)).toBeNull()
  })

  test('accepts a real-length origin in the allow-list', () => {
    const config = resolveCorsConfig({ origin: ['https://app.example.com'] })
    expect(resolveOrigin(config, 'https://app.example.com')).toBe('https://app.example.com')
  })
})
