import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { GoogleBusinessProfilePublisher } from '../src/publishers/google_business.ts'
import { PublishError } from '../src/errors.ts'
import { calls, installFetchQueue, resetCalls, restoreFetch } from './_fetch_mock.ts'
import { makeCredentials } from './_fixtures.ts'

const oauthConfig = {
  clientId: 'cid',
  clientSecret: 'csec',
}

const gbpCreds = () =>
  makeCredentials({
    platform: 'google_business',
    accountId: 'locations/LOC',
    accessToken: 'ACCESS',
    refreshToken: 'REFRESH',
    metadata: {
      account_name: 'accounts/ACCT',
      location_name: 'locations/LOC',
      location_title: 'Cafe Sundara',
    },
  })

beforeEach(() => {
  resetCalls()
})

afterEach(() => {
  restoreFetch()
})

describe('GoogleBusinessProfilePublisher.publish', () => {
  test('POSTs to /v4/{account_name}/{location_name}/localPosts with Bearer auth', async () => {
    installFetchQueue([Response.json({ name: 'accounts/ACCT/locations/LOC/localPosts/POST_ID' })])
    const p = new GoogleBusinessProfilePublisher(oauthConfig)

    const result = await p.publish(gbpCreds(), { language: 'en', body: 'today only' })

    expect(result.providerPostId).toBe('accounts/ACCT/locations/LOC/localPosts/POST_ID')
    expect(calls[0]!.url).toBe(
      'https://mybusiness.googleapis.com/v4/accounts/ACCT/locations/LOC/localPosts'
    )
    expect(calls[0]!.headers.authorization).toBe('Bearer ACCESS')
    expect(calls[0]!.body).toMatchObject({
      languageCode: 'en',
      summary: 'today only',
      topicType: 'STANDARD',
    })
  })

  test('adds media[] when an image is supplied', async () => {
    installFetchQueue([Response.json({ name: 'localPosts/X' })])
    const p = new GoogleBusinessProfilePublisher(oauthConfig)

    await p.publish(gbpCreds(), {
      language: 'en',
      body: 'hi',
      media: [{ kind: 'image', url: 'https://cdn.test/x.jpg' }],
    })

    expect(calls[0]!.body).toMatchObject({
      media: [{ mediaFormat: 'PHOTO', sourceUrl: 'https://cdn.test/x.jpg' }],
    })
  })

  test('adds callToAction when a CTA url is supplied', async () => {
    installFetchQueue([Response.json({ name: 'localPosts/X' })])
    const p = new GoogleBusinessProfilePublisher(oauthConfig)

    await p.publish(gbpCreds(), {
      language: 'en',
      body: 'visit',
      callToAction: { url: 'https://book.test' },
    })

    expect(calls[0]!.body).toMatchObject({
      callToAction: { actionType: 'LEARN_MORE', url: 'https://book.test' },
    })
  })

  test('throws PublishError on Google error envelope', async () => {
    installFetchQueue([
      new Response(JSON.stringify({ error: { code: 401, message: 'unauthenticated' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      }),
    ])
    const p = new GoogleBusinessProfilePublisher(oauthConfig)
    await expect(p.publish(gbpCreds(), { language: 'en', body: 'x' })).rejects.toThrow(
      'unauthenticated'
    )
  })
})

describe('GoogleBusinessProfilePublisher.refresh', () => {
  test('exchanges refresh_token for a new access token via Google OAuth', async () => {
    installFetchQueue([
      Response.json({ access_token: 'NEW_ACCESS', expires_in: 3600 }),
    ])
    const p = new GoogleBusinessProfilePublisher(oauthConfig)

    const tokens = await p.refresh(gbpCreds())

    expect(tokens.accessToken).toBe('NEW_ACCESS')
    expect(tokens.expiresIn).toBe(3600)
    expect(calls[0]!.url).toBe('https://oauth2.googleapis.com/token')
    expect(calls[0]!.body).toMatchObject({
      grant_type: 'refresh_token',
      client_id: 'cid',
      client_secret: 'csec',
      refresh_token: 'REFRESH',
    })
  })

  test('throws when no refresh_token is stored', async () => {
    installFetchQueue([])
    const p = new GoogleBusinessProfilePublisher(oauthConfig)
    const noRefresh = makeCredentials({
      platform: 'google_business',
      accessToken: 'A',
      refreshToken: null,
    })
    await expect(p.refresh(noRefresh)).rejects.toThrow(PublishError)
  })
})
