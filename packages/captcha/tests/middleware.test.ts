import { describe, test, expect, beforeEach } from 'bun:test'
import './setup.ts'
import { CacheManager, MemoryCacheStore } from '@strav/kernel'
import { Context } from '@strav/http'
import { captcha } from '../src/middleware.ts'
import { issueChallenge } from '../src/challenges.ts'
import { encrypt } from '@strav/kernel'
import { countLeadingZeroBits } from '../src/challenges/pow.ts'

beforeEach(() => {
  CacheManager.useStore(new MemoryCacheStore())
})

function buildContext(
  body: Record<string, unknown>,
  headers: Record<string, string> = {}
): Context {
  const request = new Request('http://localhost/test', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...headers,
    },
    body: JSON.stringify(body),
  })
  return new Context(request)
}

async function callMiddleware(
  ctx: Context,
  options: Parameters<typeof captcha>[0],
  next: () => Promise<Response> = async () => new Response('ok', { status: 200 })
): Promise<Response> {
  const middleware = captcha(options)
  return middleware(ctx, next)
}

function solvePow(challenge: string, difficulty: number): string {
  let nonce = 0
  while (true) {
    const digest = encrypt.sha256(challenge + ':' + nonce)
    if (countLeadingZeroBits(digest) >= difficulty) return String(nonce)
    nonce++
  }
}

describe('captcha middleware', () => {
  test('passes through GET requests', async () => {
    const request = new Request('http://localhost/test', { method: 'GET' })
    const ctx = new Context(request)
    const response = await callMiddleware(ctx, { types: ['honeypot', 'pow'] })
    expect(response.status).toBe(200)
  })

  test('honeypot empty → continues', async () => {
    const issued = issueChallenge('pow', { difficulty: 4 })
    const props = issued.props as { challenge: string; difficulty: number }
    const nonce = solvePow(props.challenge, props.difficulty)

    const ctx = buildContext({
      _captcha: issued.token,
      _captcha_answer: nonce,
      website: '',
    })
    const response = await callMiddleware(ctx, { types: ['honeypot', 'pow'], difficulty: 4 })
    expect(response.status).toBe(200)
  })

  test('honeypot filled → rejected with reason honeypot_tripped', async () => {
    const ctx = buildContext({ website: 'spam@bot.com' })
    const response = await callMiddleware(ctx, { types: ['honeypot'] })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { errors: { _captcha: string[] } }
    expect(body.errors._captcha[0]).toBe('honeypot_tripped')
  })

  test('missing token → token_missing', async () => {
    const ctx = buildContext({ website: '' })
    const response = await callMiddleware(ctx, { types: ['honeypot', 'pow'] })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { errors: { _captcha: string[] } }
    expect(body.errors._captcha[0]).toBe('token_missing')
  })

  test('insufficient PoW → pow_insufficient', async () => {
    const issued = issueChallenge('pow', { difficulty: 24 })
    const ctx = buildContext({
      _captcha: issued.token,
      _captcha_answer: '0',
      website: '',
    })
    const response = await callMiddleware(ctx, { types: ['honeypot', 'pow'], difficulty: 24 })
    expect(response.status).toBe(422)
    const body = (await response.json()) as { errors: { _captcha: string[] } }
    expect(body.errors._captcha[0]).toBe('pow_insufficient')
  })

  test('replay rejected after first success', async () => {
    const issued = issueChallenge('pow', { difficulty: 4 })
    const props = issued.props as { challenge: string; difficulty: number }
    const nonce = solvePow(props.challenge, props.difficulty)

    const body = { _captcha: issued.token, _captcha_answer: nonce, website: '' }

    const first = await callMiddleware(buildContext(body), {
      types: ['honeypot', 'pow'],
      difficulty: 4,
    })
    expect(first.status).toBe(200)

    const second = await callMiddleware(buildContext(body), {
      types: ['honeypot', 'pow'],
      difficulty: 4,
    })
    expect(second.status).toBe(422)
    const errBody = (await second.json()) as { errors: { _captcha: string[] } }
    expect(errBody.errors._captcha[0]).toBe('replayed')
  })

  test('mismatched type rejected (token issued for type not in guard)', async () => {
    const issued = issueChallenge('svg')
    const ctx = buildContext({
      _captcha: issued.token,
      _captcha_answer: 'whatever',
      website: '',
    })
    const response = await callMiddleware(ctx, { types: ['honeypot', 'pow'] })
    expect(response.status).toBe(422)
  })

  test('skip option bypasses verification', async () => {
    const ctx = buildContext({ website: 'looks-like-spam' })
    const response = await callMiddleware(ctx, { types: ['honeypot'], skip: () => true })
    expect(response.status).toBe(200)
  })

  test('onFailure override returns custom response', async () => {
    const ctx = buildContext({ website: 'spam' })
    const response = await callMiddleware(ctx, {
      types: ['honeypot'],
      onFailure: () => new Response('custom', { status: 418 }),
    })
    expect(response.status).toBe(418)
    expect(await response.text()).toBe('custom')
  })

  test('honeypot-only guard with empty body passes', async () => {
    const ctx = buildContext({ name: 'alice', website: '' })
    const response = await callMiddleware(ctx, { types: ['honeypot'] })
    expect(response.status).toBe(200)
  })
})
