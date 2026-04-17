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

    // Register subdomain-specific routes if subdomain routing is enabled
    if (pagesConfig.subdomains?.enabled && pagesConfig.subdomains.mappings) {
      for (const subdomain of Object.keys(pagesConfig.subdomains.mappings)) {
        router.subdomain(subdomain, (r) => {
          r.get('/', [PageController, 'handle']).as(`pages.${subdomain}.catch-home`)
          r.get('/*path', [PageController, 'handle']).as(`pages.${subdomain}.catch-all`)
        })
      }
    }

    // Register catch-all route for main domain - this must be done in boot() to ensure
    // it's registered AFTER all application routes have been registered
    router.get('/', [PageController, 'handle']).as('pages.catch-home')
    router.get('/*path', [PageController, 'handle']).as('pages.catch-all')
  }
}