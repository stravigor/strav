import { ExternalServiceError, scrubProviderError } from '@strav/kernel'
import { AbstractProvider } from '../abstract_provider.ts'
import type { SocialUser } from '../types.ts'

/**
 * LINE Login OAuth 2.1 provider.
 *
 * Distinct from the LINE Messaging API (handled by @strav/line) — this is
 * the user-facing OAuth flow that lets a website log a user in with their
 * LINE account.
 *
 * Scope notes:
 *   - `profile` (default) returns userId, displayName, pictureUrl.
 *   - `openid` (default) returns an ID token alongside the access token.
 *   - `email` is optional and requires the "Email permission" to be
 *     approved on the LINE Login channel — uncommon for new apps. The
 *     SocialUser.email will be null when this scope is not granted.
 *
 * @see https://developers.line.biz/en/docs/line-login/integrate-line-login/
 */
export class LineProvider extends AbstractProvider {
  readonly name = 'LINE'

  protected getDefaultScopes(): string[] {
    return ['profile', 'openid']
  }

  /** LINE expects client_secret in the body, not as HTTP Basic. */
  protected override defaultTokenEndpointAuthMethod(): 'basic' | 'post' {
    return 'post'
  }

  protected getAuthUrl(): string {
    return 'https://access.line.me/oauth2/v2.1/authorize'
  }

  protected getTokenUrl(): string {
    return 'https://api.line.me/oauth2/v2.1/token'
  }

  protected async getUserByToken(token: string): Promise<Record<string, unknown>> {
    const response = await fetch('https://api.line.me/v2/profile', {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!response.ok) {
      throw new ExternalServiceError(
        'LINE',
        response.status,
        scrubProviderError(await response.text())
      )
    }

    return (await response.json()) as Record<string, unknown>
  }

  protected mapUserToObject(data: Record<string, unknown>): SocialUser {
    return {
      id: data.userId as string,
      name: (data.displayName as string) ?? null,
      email: (data.email as string) ?? null,
      // LINE does not surface a "verified" flag on email; treat presence as verified.
      emailVerified: typeof data.email === 'string',
      avatar: (data.pictureUrl as string) ?? null,
      nickname: null,
      token: '',
      refreshToken: null,
      expiresIn: null,
      approvedScopes: [],
      raw: data,
    }
  }
}
