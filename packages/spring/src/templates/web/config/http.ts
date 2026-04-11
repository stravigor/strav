import { env } from '@strav/kernel'

export default {
  host: env('HOST', '0.0.0.0'),
  port: env.int('PORT', 3000),
  domain: env('DOMAIN', 'localhost'),
  public: './public',

  // Full application URL (optional - will be constructed from host/port/domain if not set)
  app_url: env('APP_URL'),
}