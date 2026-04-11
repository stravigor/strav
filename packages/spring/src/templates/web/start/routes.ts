import { router } from '@strav/http'
import HomeController from '../app/controllers/home_controller.ts'

// Web routes
router.get('/', [HomeController, 'index'])

// Health check endpoint
router.get('/health', async (ctx) => {
  return ctx.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    app: '__PROJECT_NAME__',
    version: '0.1.0'
  })
})