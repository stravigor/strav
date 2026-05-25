import { ServiceProvider } from '@strav/kernel'
import type { Application } from '@strav/kernel'
import PublisherManager from './publisher_manager.ts'

/**
 * Service provider for @strav/publish.
 *
 * Registers PublisherManager as a singleton. Apps register concrete
 * publishers themselves (typically in a bootstrap file or in the
 * `boot()` phase of an app-specific provider) because each publisher
 * needs platform-specific configuration that doesn't belong in this
 * package's defaults:
 *
 *   app.use(new PublishProvider())
 *
 *   PublisherManager.register(new WordPressPublisher())
 *   PublisherManager.register(new MetaPublisher({ appId, appSecret }))
 *   PublisherManager.register(new GoogleBusinessProfilePublisher({ clientId, clientSecret }))
 *   PublisherManager.register(new LineBroadcastPublisher())
 */
export default class PublishProvider extends ServiceProvider {
  readonly name = 'publish'
  override readonly dependencies = ['config', 'database']

  override register(app: Application): void {
    app.singleton(PublisherManager)
  }

  override boot(app: Application): void {
    app.resolve(PublisherManager)
  }
}
