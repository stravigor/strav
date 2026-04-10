import { env } from '@strav/kernel'

export default {
  name: '__PROJECT_NAME__',
  env: env('APP_ENV', 'production'),
  debug: env.bool('APP_DEBUG', false),
  url: env('APP_URL', 'http://localhost:3000'),
  port: env.int('APP_PORT', 3000),
  key: env('APP_KEY'),
}