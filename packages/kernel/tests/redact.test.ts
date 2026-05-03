import { describe, expect, test } from 'bun:test'
import { redact, defaultRedactKeys } from '../src/helpers/redact.ts'

describe('redact', () => {
  test('replaces values for default-deny keys with [REDACTED]', () => {
    const result = redact({
      authorization: 'Bearer abc',
      cookie: 'session=xyz',
      accept: 'application/json',
    })
    expect(result).toEqual({
      authorization: '[REDACTED]',
      cookie: '[REDACTED]',
      accept: 'application/json',
    })
  })

  test('matches keys case-insensitively', () => {
    const result = redact({ Authorization: 'a', AUTHORIZATION: 'b', xpassword: 'c' })
    expect(result.Authorization).toBe('[REDACTED]')
    expect(result.AUTHORIZATION).toBe('[REDACTED]')
    expect(result.xpassword).toBe('c') // 'xpassword' is not in the deny-list — exact match only
  })

  test('walks nested objects and arrays', () => {
    const result = redact({
      user: { id: 1, password: 'secret', name: 'Alice' },
      tokens: [{ access_token: 't1' }, { access_token: 't2' }],
      meta: { nested: { client_secret: 's' } },
    })
    expect((result.user as any).password).toBe('[REDACTED]')
    expect((result.user as any).name).toBe('Alice')
    expect((result.tokens as any)[0].access_token).toBe('[REDACTED]')
    expect((result.tokens as any)[1].access_token).toBe('[REDACTED]')
    expect((result.meta as any).nested.client_secret).toBe('[REDACTED]')
  })

  test('does not mutate the input', () => {
    const input = { password: 'secret', name: 'Alice' }
    const result = redact(input)
    expect(input.password).toBe('secret')
    expect(result).not.toBe(input)
  })

  test('passes Date and Buffer through unchanged', () => {
    const date = new Date('2026-01-01')
    const buffer = Buffer.from('hello')
    const result = redact({ when: date, payload: buffer, password: 'secret' })
    expect((result as any).when).toBe(date)
    expect((result as any).payload).toBe(buffer)
    expect((result as any).password).toBe('[REDACTED]')
  })

  test('passes class instances through unchanged', () => {
    class User {
      password = 'class-internal'
    }
    const u = new User()
    const result = redact({ user: u, password: 'top-level' })
    // Top-level redacted; class instance left intact (we don't reach into it)
    expect((result as any).user).toBe(u)
    expect((result as any).user.password).toBe('class-internal')
    expect((result as any).password).toBe('[REDACTED]')
  })

  test('null and undefined pass through', () => {
    expect(redact(null)).toBeNull()
    expect(redact(undefined)).toBeUndefined()
    const result = redact({ password: null, token: undefined, ok: 'value' })
    expect((result as any).password).toBeNull()
    expect((result as any).token).toBeUndefined()
    expect((result as any).ok).toBe('value')
  })

  test('extraKeys augments the default deny-list', () => {
    const result = redact(
      { internalCode: 'sek-123', password: 'p' },
      { extraKeys: ['internalCode'] }
    )
    expect((result as any).internalCode).toBe('[REDACTED]')
    expect((result as any).password).toBe('[REDACTED]')
  })

  test('keys replaces the deny-list entirely', () => {
    const result = redact({ password: 'p', custom: 'c' }, { keys: ['custom'] })
    expect((result as any).password).toBe('p') // password no longer in list
    expect((result as any).custom).toBe('[REDACTED]')
  })

  test('replacement option overrides the default', () => {
    const result = redact({ password: 'p' }, { replacement: '***' })
    expect((result as any).password).toBe('***')
  })

  test('arrays of primitives pass through unchanged', () => {
    const result = redact({ tags: ['a', 'b', 'c'] })
    expect((result as any).tags).toEqual(['a', 'b', 'c'])
  })

  test('defaultRedactKeys is exposed and includes common variants', () => {
    expect(defaultRedactKeys).toContain('authorization')
    expect(defaultRedactKeys).toContain('password')
    expect(defaultRedactKeys).toContain('access_token')
    expect(defaultRedactKeys).toContain('x-api-key')
  })
})
