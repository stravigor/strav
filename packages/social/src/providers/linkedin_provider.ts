import { ExternalServiceError, scrubProviderError } from '@strav/kernel'
import { AbstractProvider } from '../abstract_provider.ts'
import type { SocialUser } from '../types.ts'

export class LinkedInProvider extends AbstractProvider {
  readonly name = 'LinkedIn'

  protected getDefaultScopes(): string[] {
    return ['openid', 'profile', 'email']
  }

  protected getAuthUrl(): string {
    return 'https://www.linkedin.com/oauth/v2/authorization'
  }

  protected getTokenUrl(): string {
    return 'https://www.linkedin.com/oauth/v2/accessToken'
  }

  protected async getUserByToken(token: string): Promise<Record<string, unknown>> {
    const response = await fetch('https://api.linkedin.com/v2/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!response.ok) {
      throw new ExternalServiceError(
        'LinkedIn',
        response.status,
        scrubProviderError(await response.text())
      )
    }

    return (await response.json()) as Record<string, unknown>
  }

  protected mapUserToObject(data: Record<string, unknown>): SocialUser {
    return {
      id: data.sub as string,
      name: (data.name as string) ?? null,
      email: (data.email as string) ?? null,
      emailVerified: data.email_verified === true,
      avatar: (data.picture as string) ?? null,
      nickname: null,
      token: '',
      refreshToken: null,
      expiresIn: null,
      approvedScopes: [],
      raw: data,
    }
  }
}
