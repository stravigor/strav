import { inject } from '@strav/kernel'
import { ConfigurationError } from '@strav/kernel'
import { Configuration } from '@strav/kernel'
import { WhatsAppTransport } from './transports/whatsapp_transport.ts'
import { MessengerTransport } from './transports/messenger_transport.ts'
import { LineTransport } from './transports/line_transport.ts'
import { LogMessagingTransport } from './transports/log_transport.ts'
import type {
  MessagingConfig,
  MessagingProviderName,
  MessagingTransport,
} from './types.ts'

/**
 * Central instant-messaging configuration hub.
 *
 * Resolved once via the DI container — reads the messaging config and
 * eagerly instantiates each provider transport whose config is populated.
 * Unlike MailManager (single transport), an app typically uses several IM
 * providers in parallel, so transports are looked up by name.
 *
 * @example
 * app.singleton(MessagingManager)
 * app.resolve(MessagingManager)
 *
 * MessagingManager.driver('whatsapp').send({ to: '+15551234567', text: 'hi' })
 *
 * // Plug in a custom transport
 * MessagingManager.useTransport(new MyCustomTransport())
 */
@inject
export default class MessagingManager {
  private static _transports = new Map<string, MessagingTransport>()
  private static _config: MessagingConfig

  constructor(config: Configuration) {
    const driverName = config.get('messaging.default', 'log') as string

    MessagingManager._config = {
      default: driverName,
      whatsapp: {
        phoneNumberId: '',
        accessToken: '',
        ...(config.get('messaging.whatsapp', {}) as object),
      },
      messenger: {
        pageAccessToken: '',
        ...(config.get('messaging.messenger', {}) as object),
      },
      line: {
        channelAccessToken: '',
        ...(config.get('messaging.line', {}) as object),
      },
      log: {
        output: 'console',
        ...(config.get('messaging.log', {}) as object),
      },
    }

    MessagingManager._transports.clear()

    if (MessagingManager._config.whatsapp.accessToken) {
      MessagingManager._transports.set('whatsapp', new WhatsAppTransport(MessagingManager._config.whatsapp))
    }
    if (MessagingManager._config.messenger.pageAccessToken) {
      MessagingManager._transports.set('messenger', new MessengerTransport(MessagingManager._config.messenger))
    }
    if (MessagingManager._config.line.channelAccessToken) {
      MessagingManager._transports.set('line', new LineTransport(MessagingManager._config.line))
    }
    MessagingManager._transports.set('log', new LogMessagingTransport(MessagingManager._config.log))
  }

  static get config(): MessagingConfig {
    if (!MessagingManager._config) {
      throw new ConfigurationError(
        'MessagingManager not configured. Resolve it through the container first.'
      )
    }
    return MessagingManager._config
  }

  /** Look up a transport by provider name. */
  static driver(name: MessagingProviderName | string): MessagingTransport {
    const transport = MessagingManager._transports.get(name)
    if (!transport) {
      throw new ConfigurationError(
        `Unknown or unconfigured messaging provider: ${name}. ` +
          `Configure messaging.${name}.* or call MessagingManager.useTransport().`
      )
    }
    return transport
  }

  /** Whether a transport is registered for the given provider. */
  static has(name: MessagingProviderName | string): boolean {
    return MessagingManager._transports.has(name)
  }

  /** Default transport (resolved from config.messaging.default). */
  static get transport(): MessagingTransport {
    return MessagingManager.driver(MessagingManager.config.default)
  }

  /** Register or replace a transport at runtime (testing, custom providers). */
  static useTransport(transport: MessagingTransport): void {
    MessagingManager._transports.set(transport.name, transport)
  }

  /** Clear all registered transports. For testing only. */
  static reset(): void {
    MessagingManager._transports.clear()
  }
}
