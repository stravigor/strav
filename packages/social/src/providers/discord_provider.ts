import { ExternalServiceError } from '@strav/kernel'
import { AbstractProvider } from '../abstract_provider.ts'
import type { SocialUser } from '../types.ts'

export class DiscordProvider extends AbstractProvider {
  readonly name = 'Discord'

  protected getDefaultScopes(): string[] {
    return ['identify', 'email']
  }

  protected getAuthUrl(): string {
    return 'https://discord.com/api/oauth2/authorize'
  }

  protected getTokenUrl(): string {
    return 'https://discord.com/api/oauth2/token'
  }

  protected async getUserByToken(token: string): Promise<Record<string, unknown>> {
    const response = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${token}` },
    })

    if (!response.ok) {
      throw new ExternalServiceError('Discord', response.status, await response.text())
    }

    return (await response.json()) as Record<string, unknown>
  }

  protected mapUserToObject(data: Record<string, unknown>): SocialUser {
    let avatar: string | null = null
    if (data.avatar) {
      avatar = `https://cdn.discordapp.com/avatars/${data.id}/${data.avatar}.png`
    } else if (data.id) {
      const index = Number((BigInt(data.id as string) >> 22n) % 6n)
      avatar = `https://cdn.discordapp.com/embed/avatars/${index}.png`
    }

    return {
      id: data.id as string,
      name: (data.global_name as string) ?? null,
      email: (data.email as string) ?? null,
      emailVerified: data.verified === true,
      avatar,
      nickname: (data.username as string) ?? null,
      token: '',
      refreshToken: null,
      expiresIn: null,
      approvedScopes: [],
      raw: data,
    }
  }
}
