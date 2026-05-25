import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  buildAuthUrl,
  exchangeCode,
  refreshAccessToken,
} from '../src/oauth/oauth_helpers.ts'
import { calls, installFetch, resetCalls, restoreFetch } from './_fetch_mock.ts'

const config = {
  clientId: 'cid',
  clientSecret: 'csec',
  redirectUrl: 'https://app.test/callback',
}

beforeEach(() => {
  resetCalls()
})

afterEach(() => {
  restoreFetch()
})

describe('buildAuthUrl', () => {
  test('builds the standard OAuth 2 authorize URL', () => {
    const url = buildAuthUrl({
      authUrl: 'https://auth.test/oauth2/authorize',
      config,
      scopes: ['read', 'write'],
      state: 'STATE',
    })
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://auth.test/oauth2/authorize')
    expect(parsed.searchParams.get('client_id')).toBe('cid')
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.test/callback')
    expect(parsed.searchParams.get('scope')).toBe('read write')
    expect(parsed.searchParams.get('state')).toBe('STATE')
    expect(parsed.searchParams.get('response_type')).toBe('code')
  })

  test('merges extra params (access_type=offline etc.)', () => {
    const url = buildAuthUrl({
      authUrl: 'https://auth.test/x',
      config,
      scopes: [],
      state: 'S',
      extra: { access_type: 'offline', prompt: 'consent' },
    })
    const parsed = new URL(url)
    expect(parsed.searchParams.get('access_type')).toBe('offline')
    expect(parsed.searchParams.get('prompt')).toBe('consent')
  })
})

describe('exchangeCode', () => {
  test('default basic auth: sends Basic <client_id:client_secret>', async () => {
    installFetch(() => Response.json({ access_token: 'T', expires_in: 3600 }))
    await exchangeCode({
      tokenUrl: 'https://auth.test/token',
      config,
      code: 'CODE',
    })
    expect(calls[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from('cid:csec', 'utf8').toString('base64')}`
    )
    expect(calls[0]!.body).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'cid',
      code: 'CODE',
      redirect_uri: 'https://app.test/callback',
    })
    // client_secret must NOT be in the body when using Basic
    expect((calls[0]!.body as Record<string, string>).client_secret).toBeUndefined()
  })

  test('post mode: sends client_secret in the body, no Authorization header', async () => {
    installFetch(() => Response.json({ access_token: 'T' }))
    await exchangeCode({
      tokenUrl: 'https://auth.test/token',
      config,
      code: 'CODE',
      secretIn: 'post',
    })
    expect(calls[0]!.headers.authorization).toBeUndefined()
    expect(calls[0]!.body).toMatchObject({ client_secret: 'csec' })
  })

  test('maps the response into TokenResponse', async () => {
    installFetch(() =>
      Response.json({
        access_token: 'A',
        refresh_token: 'R',
        expires_in: 60,
        scope: 'read write',
        id_token: 'ID',
      })
    )
    const tokens = await exchangeCode({
      tokenUrl: 'https://auth.test/token',
      config,
      code: 'C',
    })
    expect(tokens.accessToken).toBe('A')
    expect(tokens.refreshToken).toBe('R')
    expect(tokens.expiresIn).toBe(60)
    expect(tokens.scope).toBe('read write')
    expect(tokens.raw.id_token).toBe('ID')
  })
})

describe('refreshAccessToken', () => {
  test('sends grant_type=refresh_token + refresh_token body param', async () => {
    installFetch(() => Response.json({ access_token: 'NEW' }))
    await refreshAccessToken({
      tokenUrl: 'https://auth.test/token',
      config,
      refreshToken: 'OLD',
      secretIn: 'post',
    })
    expect(calls[0]!.body).toMatchObject({
      grant_type: 'refresh_token',
      refresh_token: 'OLD',
      client_id: 'cid',
      client_secret: 'csec',
    })
  })
})
