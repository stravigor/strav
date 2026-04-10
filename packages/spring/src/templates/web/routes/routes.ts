import type { Router } from '@strav/http'
import { staticFiles } from '@strav/http'
import HomeController from '../app/controllers/home_controller.ts'

export default function (router: Router) {
  // Serve static files from public directory
  router.use(staticFiles('public'))

  // Web routes
  router.get('/', [HomeController, 'index'])
  router.get('/users', [HomeController, 'users'])

  // Health check endpoint
  router.get('/health', async (ctx) => {
    return ctx.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      app: '__PROJECT_NAME__',
      version: '0.1.0'
    })
  })
}