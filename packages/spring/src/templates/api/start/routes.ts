import { router } from '@strav/http'
import UserController from '../app/controllers/user_controller'

// Health check endpoint
router.get('/health', async (ctx) => {
  return ctx.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    app: '__PROJECT_NAME__',
    version: '0.1.0'
  })
})

// API routes
router.group('/api/v1', () => {
  // User resource routes
  router.get('/users', [UserController, 'index'])
  router.get('/users/:id', [UserController, 'show'])
  router.post('/users', [UserController, 'store'])
  router.put('/users/:id', [UserController, 'update'])
  router.delete('/users/:id', [UserController, 'destroy'])
})