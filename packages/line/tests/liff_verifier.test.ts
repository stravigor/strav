import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ExternalServiceError } from '@strav/kernel'
import { LiffVerifier } from '../src/liff/liff_verifier.ts'
import { calls, installFetch, resetCalls, restoreFetch } from './_fetch_mock.ts'

const config = { channelId: '1234567890', baseUrl: 'https://api.line.test' }

beforeEach(() => {
  resetCalls()
})

afterEach(() => {
  restoreFetch()
})

describe('LiffVerifier.verify', () => {
  test('POSTs id_token + client_id form-encoded', async () => {
    installFetch(() =>
      Response.json({
        iss: 'https://access.line.me',
        sub: 'U1',
        aud: '1234567890',
        exp: 999,
        iat: 1,
      })
    )
    const v = new LiffVerifier(config)

    const claims = await v.verify('IDTOKEN')

    expect(claims.sub).toBe('U1')
    expect(calls[0]!.url).toBe('https://api.line.test/oauth2/v2.1/verify')
    expect(calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded')
    // body was JSON.parsed by the fetch mock helper because it wasn't form-encoded;
    // but the mock's safeJson fall-through keeps it as a string in that case.
    const body = calls[0]!.body as string
    expect(body).toContain('id_token=IDTOKEN')
    expect(body).toContain('client_id=1234567890')
  })

  test('throws ExternalServiceError on LINE error response', async () => {
    installFetch(
      () =>
        new Response(JSON.stringify({ error_description: 'expired' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
    )
    const v = new LiffVerifier(config)
    await expect(v.verify('BAD')).rejects.toThrow('expired')
  })

  test('rejects empty idToken', async () => {
    installFetch(() => Response.json({}))
    const v = new LiffVerifier(config)
    await expect(v.verify('')).rejects.toThrow(ExternalServiceError)
  })
})

describe('LiffVerifier.verifyAccessToken', () => {
  test('rejects mismatched client_id', async () => {
    installFetch(() =>
      Response.json({ scope: 'profile openid', client_id: 'OTHER', expires_in: 60 })
    )
    const v = new LiffVerifier(config)
    await expect(v.verifyAccessToken('TOK')).rejects.toThrow('expected 1234567890')
  })

  test('returns info on matching client_id', async () => {
    installFetch(() =>
      Response.json({ scope: 'profile openid', client_id: '1234567890', expires_in: 60 })
    )
    const v = new LiffVerifier(config)
    const info = await v.verifyAccessToken('TOK')
    expect(info.client_id).toBe('1234567890')
    expect(info.expires_in).toBe(60)
  })
})
