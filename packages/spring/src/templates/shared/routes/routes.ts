import type { Router } from '@strav/http'

export default function (router: Router) {
  // Health check endpoint
  router.get('/health', async (ctx) => {
    return ctx.json({ status: 'ok', timestamp: new Date().toISOString() })
  })

  // API routes
  router.group('/api', () => {
    // Add your API routes here
  })
}