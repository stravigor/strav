import { ServiceProvider } from '@strav/kernel'
import type { Application } from '@strav/kernel'
import LineManager from './line_manager.ts'

/**
 * Service provider that registers LineManager with the DI container.
 *
 * Coexists with @strav/signal's MessagingProvider — both can be registered;
 * one (LineManager) gives full LINE SDK access (Flex, Rich Menu, LIFF,
 * content download), the other gives a provider-agnostic messaging
 * abstraction (`messaging.via('line').to(...).text(...).send()`).
 */
export default class LineProvider extends ServiceProvider {
  readonly name = 'line'
  override readonly dependencies = ['config']

  override register(app: Application): void {
    app.singleton(LineManager)
  }

  override boot(app: Application): void {
    app.resolve(LineManager)
  }
}
