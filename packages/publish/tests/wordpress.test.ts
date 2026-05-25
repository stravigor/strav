import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { WordPressPublisher } from '../src/publishers/wordpress.ts'
import { PublishError } from '../src/errors.ts'
import { calls, installFetchQueue, resetCalls, restoreFetch } from './_fetch_mock.ts'
import { makeCredentials } from './_fixtures.ts'

const creds = (extra: Partial<Record<string, unknown>> = {}) =>
  makeCredentials({
    platform: 'wordpress',
    accountId: 'example.com',
    accessToken: 'app-password',
    metadata: {
      site_url: 'https://example.test',
      username: 'editor',
      ...extra,
    },
  })

beforeEach(() => {
  resetCalls()
})

afterEach(() => {
  restoreFetch()
})

describe('WordPressPublisher.publish', () => {
  test('text post: Basic auth + JSON body, returns post id + link', async () => {
    installFetchQueue([
      Response.json({ id: 42, link: 'https://example.test/?p=42' }),
    ])
    const p = new WordPressPublisher()

    const result = await p.publish(creds(), {
      language: 'en',
      title: 'Hello',
      body: 'world',
    })

    expect(result.providerPostId).toBe('42')
    expect(result.url).toBe('https://example.test/?p=42')
    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe('https://example.test/wp-json/wp/v2/posts')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers.authorization).toMatch(/^Basic /)
    expect(calls[0]!.body).toMatchObject({
      title: 'Hello',
      content: 'world',
      status: 'publish',
      meta: { strav_language: 'en' },
    })
  })

  test('image post: uploads media first, then creates the post with featured_media', async () => {
    installFetchQueue([
      // Media fetch (the image URL itself)
      new Response('FAKE_BYTES', {
        status: 200,
        headers: { 'content-type': 'image/jpeg' },
      }),
      // WP /media upload
      Response.json({ id: 99, source_url: 'https://example.test/wp-content/uploads/x.jpg' }),
      // WP /posts create
      Response.json({ id: 100, link: 'https://example.test/?p=100' }),
    ])
    const p = new WordPressPublisher()

    const result = await p.publish(creds(), {
      language: 'en',
      body: 'with image',
      media: [{ kind: 'image', url: 'https://cdn.test/x.jpg', contentType: 'image/jpeg' }],
    })

    expect(result.providerPostId).toBe('100')
    expect(calls).toHaveLength(3)
    // The /media call is multipart-ish — Content-Disposition is set
    expect(calls[1]!.url).toBe('https://example.test/wp-json/wp/v2/media')
    expect(calls[1]!.headers['content-disposition']).toContain('filename="x.jpg"')
    expect(calls[1]!.headers['content-type']).toBe('image/jpeg')
    // The /posts call carries featured_media: 99
    expect(calls[2]!.body).toMatchObject({ featured_media: 99 })
  })

  test('derives a title from the first body line when title is missing', async () => {
    installFetchQueue([Response.json({ id: 1, link: 'x' })])
    const p = new WordPressPublisher()
    await p.publish(creds(), { language: 'en', body: 'First line\nsecond' })
    expect(calls[0]!.body).toMatchObject({ title: 'First line' })
  })

  test('throws PublishError on non-2xx with the WP error message', async () => {
    installFetchQueue([
      new Response(JSON.stringify({ message: 'invalid' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    ])
    const p = new WordPressPublisher()
    await expect(p.publish(creds(), { language: 'en', body: 'x' })).rejects.toThrow(PublishError)
  })

  test('throws when site_url metadata is missing', async () => {
    installFetchQueue([])
    const p = new WordPressPublisher()
    const bad = creds({ site_url: undefined as unknown as string })
    await expect(p.publish(bad, { language: 'en', body: 'x' })).rejects.toThrow('site_url')
  })
})
