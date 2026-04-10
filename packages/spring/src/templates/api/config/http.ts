import { env } from '@strav/kernel'

export default {
  port: env.int('APP_PORT', 3000),
  cors: {
    enabled: true,
    origin: ['http://localhost:3000', 'http://localhost:5173'],
    credentials: true,
  },
}