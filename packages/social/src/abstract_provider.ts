import type { Context, Session } from '@strav/http'
import { randomHex, ExternalServiceError, scrubProviderError } from '@strav/kernel'
import type { ProviderConfig, SocialUser, TokenResponse } from './types.ts'

const STATE_KEY = 'social_state'

export abstract class AbstractProvider {
  abstract readonly name: string

  protected config: ProviderConfig
  protected _scopes: string[]
  protected _parameters: Record<string, string> = {}

  constructor(config: ProviderConfig) {
    this.config = config
    this._scopes = config.scopes ?? this.getDefaultScopes()
  }

  // ---------------------------------------------------------------------------
  // Template methods — each provider implements these
  // ---------------------------------------------------------------------------

  protected abstract getDefaultScopes(): string[]
  protected abstract getAuthUrl(): string
  protected abstract getTokenUrl(): string
  protected abstract getUserByToken(token: string): Promise<Record<string, unknown>>
  protected abstract mapUserToObject(data: Record<string, unknown>): SocialUser

  // ---------------------------------------------------------------------------
  // Fluent API
  // ---------------------------------------------------------------------------

  scopes(scopes: string[]): this {
    this._scopes = [...new Set([...this._scopes, ...scopes])]
    return this
  }

  setScopes(scopes: string[]): this {
    this._scopes = scopes
    return this
  }

  with(params: Record<string, string>): this {
    this._parameters = { ...this._parameters, ...params }
    return this
  }

  // ---------------------------------------------------------------------------
  // OAuth flow
  // ---------------------------------------------------------------------------

  redirect(ctx: Context): Response {
    const state = randomHex(32)
    const session = ctx.get<Session>('session')
    session.set(STATE_KEY, state)

    const url = this.buildAuthUrl(state)
    return ctx.redirect(url)
  }

  async user(ctx: Context): Promise<SocialUser> {
    const session = ctx.get<Session>('session')
    const expectedState = session.get<string>(STATE_KEY)
    const returnedState = ctx.query.get('state')

    if (!expectedState || expectedState !== returnedState) {
      throw new SocialError('Invalid state parameter. Possible CSRF attack.')
    }

    session.forget(STATE_KEY)

    const code = ctx.query.get('code')
    if (!code) {
      const error = ctx.query.get('error')
      throw new SocialError(error ? `OAuth error: ${error}` : 'Missing authorization code.')
    }

    const token = await this.getAccessToken(code)
    const data = await this.getUserByToken(token.accessToken)
    const user = this.mapUserToObject(data)

    user.token = token.accessToken
    user.refreshToken = token.refreshToken
    user.expiresIn = token.expiresIn
    user.approvedScopes = token.scope ? token.scope.split(/[\s,]+/) : this._scopes
    user.raw = data

    return user
  }

  async userFromToken(token: string): Promise<SocialUser> {
    const data = await this.getUserByToken(token)
    const user = this.mapUserToObject(data)

    user.token = token
    user.refreshToken = null
    user.expiresIn = null
    user.approvedScopes = this._scopes
    user.raw = data

    return user
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  protected async getAccessToken(code: string): Promise<TokenResponse> {
    const response = await fetch(this.getTokenUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: this.config.redirectUrl,
      }),
    })

    if (!response.ok) {
      const text = await response.text()
      throw new ExternalServiceError(this.name, response.status, scrubProviderError(text))
    }

    const data = (await response.json()) as Record<string, unknown>

    return {
      accessToken: data.access_token as string,
      refreshToken: (data.refresh_token as string) ?? null,
      expiresIn: (data.expires_in as number) ?? null,
      scope: (data.scope as string) ?? null,
    }
  }

  protected buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUrl,
      response_type: 'code',
      scope: this._scopes.join(' '),
      state,
      ...this._parameters,
    })

    return `${this.getAuthUrl()}?${params.toString()}`
  }
}

export class SocialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SocialError'
  }
}
