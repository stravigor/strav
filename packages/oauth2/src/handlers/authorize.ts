import type { Context, Session } from '@strav/http'
import { Emitter } from '@strav/kernel'
import { getUserId } from '../utils.ts'
import OAuth2Manager from '../oauth2_manager.ts'
import OAuthClient from '../client.ts'
import AuthCode from '../auth_code.ts'
import ScopeRegistry from '../scopes.ts'
import { OAuth2Events } from '../types.ts'
import {
  InvalidRequestError,
  InvalidClientError,
  InvalidScopeError,
  AccessDeniedError,
} from '../errors.ts'

/**
 * GET /oauth/authorize
 *
 * Initiates the authorization code flow. Validates the request parameters,
 * then either auto-approves (first-party client) or shows the consent screen.
 */
export async function authorizeHandler(ctx: Context): Promise<Response> {
  const responseType = ctx.qs('response_type')
  const clientId = ctx.qs('client_id')
  const redirectUri = ctx.qs('redirect_uri')
  const scopeParam = ctx.qs('scope')
  const state = ctx.qs('state')
  const codeChallenge = ctx.qs('code_challenge')
  // Default to S256 (RFC 7636 §4.3 — recommended). Plain is accepted
  // only when the deployment opts in via `oauth2.allowPlainPkce`.
  const codeChallengeMethod = ctx.qs('code_challenge_method') ?? 'S256'

  // Validate required params
  if (responseType !== 'code') {
    return ctx.json(new InvalidRequestError('The response_type must be "code".').toJSON(), 400)
  }

  if (!clientId) {
    return ctx.json(new InvalidRequestError('The client_id parameter is required.').toJSON(), 400)
  }

  // Look up client
  const client = await OAuthClient.find(clientId)
  if (!client || client.revoked) {
    return ctx.json(new InvalidClientError().toJSON(), 401)
  }

  // Must support authorization_code grant
  if (!client.grantTypes.includes('authorization_code')) {
    return ctx.json(
      new InvalidRequestError(
        'This client does not support the authorization_code grant.'
      ).toJSON(),
      400
    )
  }

  // Validate redirect URI
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return ctx.json(
      new InvalidRequestError(
        'The redirect_uri is missing or not registered for this client.'
      ).toJSON(),
      400
    )
  }

  // Public clients must use PKCE
  if (!client.confidential && !codeChallenge) {
    return errorRedirect(
      redirectUri,
      state,
      'invalid_request',
      'Public clients must use PKCE (code_challenge required).'
    )
  }

  // Validate code_challenge_method. Plain PKCE is gated behind a
  // config flag because it transmits the verifier in the clear and is
  // strictly weaker than S256.
  if (codeChallenge) {
    if (codeChallengeMethod !== 'S256' && codeChallengeMethod !== 'plain') {
      return errorRedirect(
        redirectUri,
        state,
        'invalid_request',
        'Unsupported code_challenge_method. Use "S256".'
      )
    }
    if (codeChallengeMethod === 'plain' && !OAuth2Manager.config.allowPlainPkce) {
      return errorRedirect(
        redirectUri,
        state,
        'invalid_request',
        'code_challenge_method=plain is disabled on this server. Use "S256".'
      )
    }
  }

  // Validate scopes
  const requestedScopes = scopeParam ? scopeParam.split(' ').filter(Boolean) : []
  let scopes: string[]
  try {
    scopes = ScopeRegistry.validate(
      requestedScopes,
      client.scopes,
      OAuth2Manager.config.defaultScopes
    )
  } catch (err) {
    if (err instanceof InvalidScopeError) {
      return errorRedirect(redirectUri, state, 'invalid_scope', err.message)
    }
    throw err
  }

  // Store authorization request in session for the POST approval step
  const session = ctx.get<Session>('session')
  session.set('_oauth2_auth_request', {
    clientId,
    redirectUri,
    scopes,
    state: state ?? null,
    codeChallenge: codeChallenge ?? null,
    codeChallengeMethod: codeChallenge ? codeChallengeMethod : null,
  })

  // First-party clients skip consent
  if (client.firstParty) {
    return issueAuthorizationCode(
      ctx,
      client.id,
      redirectUri,
      scopes,
      state,
      codeChallenge,
      codeChallengeMethod
    )
  }

  // Third-party: render consent screen
  const scopeDescriptions = ScopeRegistry.describe(scopes)
  if (OAuth2Manager.actions.renderAuthorization) {
    return OAuth2Manager.actions.renderAuthorization(ctx, client, scopeDescriptions)
  }

  // Default: JSON response for SPA-based consent
  return ctx.json({
    authorization_required: true,
    client: { id: client.id, name: client.name },
    scopes: scopeDescriptions,
    state: state ?? null,
  })
}

/**
 * POST /oauth/authorize
 *
 * Handles the user's approval or denial of the authorization request.
 */
export async function approveHandler(ctx: Context): Promise<Response> {
  const body = await ctx.body<{ approved?: boolean }>()
  const session = ctx.get<Session>('session')

  const authRequest = session.get<{
    clientId: string
    redirectUri: string
    scopes: string[]
    state: string | null
    codeChallenge: string | null
    codeChallengeMethod: string | null
  }>('_oauth2_auth_request')

  if (!authRequest) {
    return ctx.json(new InvalidRequestError('No pending authorization request.').toJSON(), 400)
  }

  // Clear the session data
  session.forget('_oauth2_auth_request')

  // User denied
  if (!body.approved) {
    if (Emitter.listenerCount(OAuth2Events.ACCESS_DENIED) > 0) {
      Emitter.emit(OAuth2Events.ACCESS_DENIED, { ctx, clientId: authRequest.clientId }).catch(
        () => {}
      )
    }
    return errorRedirect(
      authRequest.redirectUri,
      authRequest.state,
      'access_denied',
      'The resource owner denied the request.'
    )
  }

  // User approved — issue code
  return issueAuthorizationCode(
    ctx,
    authRequest.clientId,
    authRequest.redirectUri,
    authRequest.scopes,
    authRequest.state,
    authRequest.codeChallenge,
    authRequest.codeChallengeMethod
  )
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

async function issueAuthorizationCode(
  ctx: Context,
  clientId: string,
  redirectUri: string,
  scopes: string[],
  state: string | null,
  codeChallenge: string | null,
  codeChallengeMethod: string | null
): Promise<Response> {
  const user = ctx.get('user')
  const userId = getUserId(user)

  const { code } = await AuthCode.create({
    clientId,
    userId,
    redirectUri,
    scopes,
    codeChallenge,
    codeChallengeMethod,
  })

  if (Emitter.listenerCount(OAuth2Events.CODE_ISSUED) > 0) {
    Emitter.emit(OAuth2Events.CODE_ISSUED, { ctx, clientId, userId }).catch(() => {})
  }

  // Redirect back to client with code
  const url = new URL(redirectUri)
  url.searchParams.set('code', code)
  if (state) url.searchParams.set('state', state)

  return ctx.redirect(url.toString())
}

function errorRedirect(
  redirectUri: string,
  state: string | null,
  error: string,
  description: string
): Response {
  const url = new URL(redirectUri)
  url.searchParams.set('error', error)
  url.searchParams.set('error_description', description)
  if (state) url.searchParams.set('state', state)

  return Response.redirect(url.toString(), 302)
}
