import { ExternalServiceError, scrubProviderError } from '@strav/kernel'
import { AbstractProvider } from '../abstract_provider.ts'
import type { SocialUser } from '../types.ts'

export class GoogleProvider extends AbstractProvider {
  readonly name = 'Google'

  protected getDefaultScopes(): string[] {
    return ['openid', 'email', 'profile']
  }

  protected getAuthUrl(): string {
    return 'https://accounts.google.com/o/oauth2/v2/auth'
  }

  protected getTokenUrl(): string {
    return 'https://oauth2.googleapis.com/token'
  }

  protected async getUserByToken(token: string): Promise<Record<string, unknown>> {
    const response = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!response.ok) {
      throw new ExternalServiceError(
        'Google',
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
