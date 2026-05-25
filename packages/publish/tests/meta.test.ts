import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  FacebookPagePublisher,
  InstagramPublisher,
} from '../src/publishers/meta.ts'
import { PublishError } from '../src/errors.ts'
import { calls, installFetchQueue, resetCalls, restoreFetch } from './_fetch_mock.ts'
import { makeCredentials } from './_fixtures.ts'

const fbCreds = () =>
  makeCredentials({
    platform: 'facebook',
    accountId: 'PAGE_ID',
    accessToken: 'PAGE_TOKEN',
    metadata: { page_id: 'PAGE_ID', page_name: 'Cafe', ig_account_id: 'IG_ID' },
  })

beforeEach(() => {
  resetCalls()
})

afterEach(() => {
  restoreFetch()
})

describe('FacebookPagePublisher.publish', () => {
  test('text post: POSTs /{page-id}/feed with message + access_token', async () => {
    installFetchQueue([Response.json({ id: 'PAGE_ID_111' })])
    const p = new FacebookPagePublisher()

    const result = await p.publish(fbCreds(), { language: 'en', body: 'hello world' })

    expect(result.providerPostId).toBe('PAGE_ID_111')
    expect(result.url).toBe('https://facebook.com/PAGE_ID_111')
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/PAGE_ID/feed')
    expect(calls[0]!.body).toMatchObject({
      message: 'hello world',
      access_token: 'PAGE_TOKEN',
    })
  })

  test('text post with CTA URL adds link param', async () => {
    installFetchQueue([Response.json({ id: 'X' })])
    const p = new FacebookPagePublisher()

    await p.publish(fbCreds(), {
      language: 'en',
      body: 'hi',
      callToAction: { url: 'https://book.test' },
    })

    expect(calls[0]!.body).toMatchObject({ link: 'https://book.test' })
  })

  test('image post: POSTs /{page-id}/photos with url + caption', async () => {
    installFetchQueue([Response.json({ id: 'PHOTO_ID', post_id: 'PAGE_ID_222' })])
    const p = new FacebookPagePublisher()

    const result = await p.publish(fbCreds(), {
      language: 'en',
      body: 'cute',
      media: [{ kind: 'image', url: 'https://cdn.test/x.jpg' }],
    })

    expect(result.providerPostId).toBe('PAGE_ID_222')
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/PAGE_ID/photos')
    expect(calls[0]!.body).toMatchObject({
      url: 'https://cdn.test/x.jpg',
      caption: 'cute',
    })
  })

  test('throws PublishError on Graph API error envelope', async () => {
    installFetchQueue([
      new Response(JSON.stringify({ error: { message: 'oops', type: 'OAuthException' } }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    ])
    const p = new FacebookPagePublisher()
    await expect(p.publish(fbCreds(), { language: 'en', body: 'x' })).rejects.toThrow('oops')
  })
})

describe('InstagramPublisher.publish', () => {
  test('image post: two-step create container + publish', async () => {
    installFetchQueue([
      Response.json({ id: 'CONTAINER_42' }),
      Response.json({ id: 'MEDIA_777' }),
    ])
    const p = new InstagramPublisher()

    const result = await p.publish(fbCreds(), {
      language: 'en',
      body: 'cute',
      media: [{ kind: 'image', url: 'https://cdn.test/x.jpg' }],
    })

    expect(result.providerPostId).toBe('MEDIA_777')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toBe('https://graph.facebook.com/v21.0/IG_ID/media')
    expect(calls[0]!.body).toMatchObject({
      image_url: 'https://cdn.test/x.jpg',
      caption: 'cute',
    })
    expect(calls[1]!.url).toBe('https://graph.facebook.com/v21.0/IG_ID/media_publish')
    expect(calls[1]!.body).toMatchObject({ creation_id: 'CONTAINER_42' })
  })

  test('video post: uses REELS media_type + video_url', async () => {
    installFetchQueue([
      Response.json({ id: 'CONTAINER_VID' }),
      Response.json({ id: 'REEL_999' }),
    ])
    const p = new InstagramPublisher()

    await p.publish(fbCreds(), {
      language: 'en',
      body: 'short',
      media: [{ kind: 'video', url: 'https://cdn.test/x.mp4' }],
    })

    expect(calls[0]!.body).toMatchObject({
      media_type: 'REELS',
      video_url: 'https://cdn.test/x.mp4',
    })
  })

  test('appends callToAction url to the caption', async () => {
    installFetchQueue([
      Response.json({ id: 'C' }),
      Response.json({ id: 'M' }),
    ])
    const p = new InstagramPublisher()

    await p.publish(fbCreds(), {
      language: 'en',
      body: 'visit us',
      media: [{ kind: 'image', url: 'https://cdn.test/x.jpg' }],
      callToAction: { url: 'https://book.test' },
    })

    expect(calls[0]!.body).toMatchObject({
      caption: 'visit us\n\nhttps://book.test',
    })
  })

  test('throws when ig_account_id is missing', async () => {
    installFetchQueue([])
    const p = new InstagramPublisher()
    const noIg = makeCredentials({
      platform: 'instagram',
      accessToken: 'T',
      metadata: { page_id: 'P' },
    })
    await expect(
      p.publish(noIg, {
        language: 'en',
        body: 'x',
        media: [{ kind: 'image', url: 'https://cdn.test/x.jpg' }],
      })
    ).rejects.toThrow('ig_account_id')
  })

  test('throws when there is no media', async () => {
    installFetchQueue([])
    const p = new InstagramPublisher()
    await expect(
      p.publish(fbCreds(), { language: 'en', body: 'x' })
    ).rejects.toThrow('requires at least one image or video')
  })
})
