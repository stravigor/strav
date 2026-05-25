import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import PublisherManager from '../src/publisher_manager.ts'
import { PublisherNotRegisteredError } from '../src/errors.ts'
import type { Publisher } from '../src/publisher.ts'
import type { PublisherCredentialsData } from '../src/credentials/credentials.ts'
import type { PublishContent, PublishResult, RefreshedTokens } from '../src/types.ts'
import { makeCredentials } from './_fixtures.ts'

class FakePublisher implements Publisher {
  publishCalls: { credentials: PublisherCredentialsData; content: PublishContent }[] = []
  refreshCalls: PublisherCredentialsData[] = []
  refreshReturn: RefreshedTokens = {
    accessToken: 'REFRESHED',
    expiresIn: 3600,
  }

  constructor(public readonly name: string, private readonly canRefresh = true) {}

  async publish(
    credentials: PublisherCredentialsData,
    content: PublishContent
  ): Promise<PublishResult> {
    this.publishCalls.push({ credentials, content })
    return { providerPostId: 'OK' }
  }

  refresh = this.canRefresh
    ? async (credentials: PublisherCredentialsData): Promise<RefreshedTokens> => {
        this.refreshCalls.push(credentials)
        return this.refreshReturn
      }
    : undefined as unknown as Publisher['refresh']
}

beforeEach(() => {
  PublisherManager.reset()
})

afterEach(() => {
  PublisherManager.reset()
})

describe('PublisherManager.register / get / has', () => {
  test('register stores by publisher.name', () => {
    const p = new FakePublisher('test_platform')
    PublisherManager.register(p)
    expect(PublisherManager.has('test_platform')).toBe(true)
    expect(PublisherManager.get('test_platform')).toBe(p)
  })

  test('get throws PublisherNotRegisteredError for unknown name', () => {
    expect(() => PublisherManager.get('nope')).toThrow(PublisherNotRegisteredError)
  })
})

describe('PublisherManager.refreshIfExpired', () => {
  test('returns input unchanged when token is not expired', async () => {
    const p = new FakePublisher('x')
    const credentials = makeCredentials({ expiresAt: new Date(Date.now() + 3_600_000) })
    const result = await PublisherManager.refreshIfExpired(p, credentials)
    expect(result).toBe(credentials)
    expect(p.refreshCalls).toHaveLength(0)
  })

  test('throws CredentialsRefreshError when expired and publisher has no refresh hook', async () => {
    const p = new FakePublisher('x', /* canRefresh */ false)
    const credentials = makeCredentials({ expiresAt: new Date(Date.now() - 1000) })
    await expect(PublisherManager.refreshIfExpired(p, credentials)).rejects.toThrow(
      'access token expired'
    )
  })

  test('surfaces a publisher refresh error wrapped as CredentialsRefreshError', async () => {
    const p = new FakePublisher('x')
    p.refresh = async () => {
      throw new Error('upstream said no')
    }
    const credentials = makeCredentials({ expiresAt: new Date(Date.now() - 1000) })
    await expect(PublisherManager.refreshIfExpired(p, credentials)).rejects.toThrow(
      'upstream said no'
    )
  })
})
