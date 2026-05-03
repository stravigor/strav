import { ExternalServiceError, scrubProviderError } from '@strav/kernel'
import { AbstractProvider } from '../abstract_provider.ts'
import type { SocialUser } from '../types.ts'

const API_VERSION = 'v21.0'

export class FacebookProvider extends AbstractProvider {
  readonly name = 'Facebook'

  protected getDefaultScopes(): string[] {
    return ['email', 'public_profile']
  }

  protected getAuthUrl(): string {
    return `https://www.facebook.com/${API_VERSION}/dialog/oauth`
  }

  protected getTokenUrl(): string {
    return `https://graph.facebook.com/${API_VERSION}/oauth/access_token`
  }

  protected async getUserByToken(token: string): Promise<Record<string, unknown>> {
    const fields = 'id,name,email,picture.type(large)'
    const response = await fetch(
      `https://graph.facebook.com/${API_VERSION}/me?fields=${fields}&access_token=${token}`
    )

    if (!response.ok) {
      throw new ExternalServiceError(
        'Facebook',
        response.status,
        scrubProviderError(await response.text())
      )
    }

    return (await response.json()) as Record<string, unknown>
  }

  protected mapUserToObject(data: Record<string, unknown>): SocialUser {
    const picture = data.picture as { data?: { url?: string } } | undefined
    const email = (data.email as string) ?? null

    return {
      id: data.id as string,
      name: (data.name as string) ?? null,
      email,
      // Facebook's Graph API only returns the user's verified primary email;
      // an unverified address is omitted from the response entirely.
      emailVerified: email !== null,
      avatar: picture?.data?.url ?? null,
      nickname: null,
      token: '',
      refreshToken: null,
      expiresIn: null,
      approvedScopes: [],
      raw: data,
    }
  }
}
