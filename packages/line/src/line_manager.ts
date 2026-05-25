import { inject, Configuration, ConfigurationError } from '@strav/kernel'
import { LineClient } from './client/line_client.ts'
import { RichMenuClient } from './rich_menu/rich_menu_client.ts'
import { LiffVerifier } from './liff/liff_verifier.ts'
import type { LineConfig } from './types.ts'

/**
 * Central LINE configuration hub.
 *
 * Resolved once via the DI container. Holds the parsed LineConfig and
 * eagerly instantiates the LineClient + RichMenuClient bound to the
 * configured channel access token. LiffVerifier is lazy because the LIFF
 * config block is optional.
 *
 * @example
 * app.singleton(LineManager)
 * app.resolve(LineManager)
 *
 * LineManager.client.push('U1234', textMessage('hi'))
 * LineManager.richMenu.create({ ... })
 * await LineManager.liff().verify(idToken)
 */
@inject
export default class LineManager {
  private static _config: LineConfig
  private static _client: LineClient
  private static _richMenu: RichMenuClient
  private static _liff?: LiffVerifier

  constructor(config: Configuration) {
    const raw = (config.get('line', {}) as Partial<LineConfig>) ?? {}
    if (!raw.channelAccessToken) {
      throw new ConfigurationError(
        'LineManager requires line.channelAccessToken in configuration'
      )
    }

    LineManager._config = {
      channelAccessToken: raw.channelAccessToken,
      channelSecret: raw.channelSecret,
      baseUrl: raw.baseUrl ?? 'https://api.line.me',
      dataBaseUrl: raw.dataBaseUrl ?? 'https://api-data.line.me',
      liff: raw.liff,
      login: raw.login,
    }

    LineManager._client = new LineClient({
      channelAccessToken: LineManager._config.channelAccessToken,
      baseUrl: LineManager._config.baseUrl,
      dataBaseUrl: LineManager._config.dataBaseUrl,
    })
    LineManager._richMenu = new RichMenuClient({
      channelAccessToken: LineManager._config.channelAccessToken,
      baseUrl: LineManager._config.baseUrl,
      dataBaseUrl: LineManager._config.dataBaseUrl,
    })
    LineManager._liff = LineManager._config.liff
      ? new LiffVerifier({ channelId: LineManager._config.liff.channelId })
      : undefined
  }

  static get config(): LineConfig {
    if (!LineManager._config) {
      throw new ConfigurationError(
        'LineManager not configured. Resolve it through the container first.'
      )
    }
    return LineManager._config
  }

  static get client(): LineClient {
    return LineManager._client
  }

  static get richMenu(): RichMenuClient {
    return LineManager._richMenu
  }

  /** Returns the LIFF verifier; throws if `line.liff` is not configured. */
  static liff(): LiffVerifier {
    if (!LineManager._liff) {
      throw new ConfigurationError(
        'LIFF is not configured. Set line.liff.channelId to enable LIFF token verification.'
      )
    }
    return LineManager._liff
  }

  /** Replace the underlying LineClient (testing / custom transport). */
  static useClient(client: LineClient): void {
    LineManager._client = client
  }

  /** Replace the underlying RichMenuClient (testing). */
  static useRichMenu(client: RichMenuClient): void {
    LineManager._richMenu = client
  }

  /** Replace the LIFF verifier (testing). */
  static useLiff(verifier: LiffVerifier): void {
    LineManager._liff = verifier
  }
}
