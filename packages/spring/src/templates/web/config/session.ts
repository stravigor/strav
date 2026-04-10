import { env } from '@strav/kernel'

export default {
  secret: env('SESSION_SECRET'),
  cookieName: env('SESSION_COOKIE_NAME', 'session'),
  maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
  secure: env('APP_ENV') === 'production',
  httpOnly: true,
  sameSite: 'lax' as const,
}