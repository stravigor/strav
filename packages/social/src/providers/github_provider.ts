import { ExternalServiceError, scrubProviderError } from '@strav/kernel'
import { AbstractProvider } from '../abstract_provider.ts'
import type { SocialUser } from '../types.ts'

export class GitHubProvider extends AbstractProvider {
  readonly name = 'GitHub'

  protected getDefaultScopes(): string[] {
    return ['read:user', 'user:email']
  }

  protected getAuthUrl(): string {
    return 'https://github.com/login/oauth/authorize'
  }

  protected getTokenUrl(): string {
    return 'https://github.com/login/oauth/access_token'
  }

  protected async getUserByToken(token: string): Promise<Record<string, unknown>> {
    const headers = {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'User-Agent': 'Strav-Social',
    }

    const [userResponse, emailsResponse] = await Promise.all([
      fetch('https://api.github.com/user', { headers }),
      fetch('https://api.github.com/user/emails', { headers }),
    ])

    if (!userResponse.ok) {
      throw new ExternalServiceError(
        'GitHub',
        userResponse.status,
        scrubProviderError(await userResponse.text())
      )
    }

    const user = (await userResponse.json()) as Record<string, unknown>

    // If the user's profile email is private, fall back to the primary verified email
    if (!user.email && emailsResponse.ok) {
      const emails = (await emailsResponse.json()) as Array<{
        email: string
        primary: boolean
        verified: boolean
      }>
      const primary = emails.find(e => e.primary && e.verified)
      if (primary) user.email = primary.email
    }

    return user
  }

  protected mapUserToObject(data: Record<string, unknown>): SocialUser {
    const email = (data.email as string) ?? null
    return {
      id: String(data.id),
      name: (data.name as string) ?? null,
      email,
      // GitHub only exposes verified emails: the profile `email` is required
      // to be a verified address, and the fallback path in getUserByToken
      // filters /user/emails for `verified === true`.
      emailVerified: email !== null,
      avatar: (data.avatar_url as string) ?? null,
      nickname: (data.login as string) ?? null,
      token: '',
      refreshToken: null,
      expiresIn: null,
      approvedScopes: [],
      raw: data,
    }
  }
}
