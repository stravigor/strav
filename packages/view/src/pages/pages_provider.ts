import ServiceProvider from '@strav/kernel/core/service_provider'
import type Application from '@strav/kernel/core/application'
import Configuration from '@strav/kernel/config/configuration'
import Router from '@strav/http/http/router'
import PageController from './page_controller.ts'
import type { ViewConfigWithPages } from './types.ts'

/**
 * Service provider for static pages functionality
 */
export default class PagesProvider extends ServiceProvider {
  readonly name = 'pages'
  override readonly dependencies = ['config', 'http', 'view']

  override async boot(app: Application): Promise<void> {
    const config = app.resolve(Configuration)
    const viewConfig = config.get('view', {}) as ViewConfigWithPages
    const pagesConfig = viewConfig.pages

    // Only register static page routes if pages are enabled
    if (!pagesConfig?.enabled) {
      return
    }

    const router = app.resolve(Router)

    // Register catch-all route - this must be done in boot() to ensure
    // it's registered AFTER all application routes have been registered
    router.get('/', [PageController, 'handle']).as('pages.catch-home')
    router.get('/*path', [PageController, 'handle']).as('pages.catch-all')
  }
}