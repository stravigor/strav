import { env } from '@strav/kernel'

export default {
  host: env('DB_HOST', 'localhost'),
  port: env.int('DB_PORT', 5432),
  database: env('DB_DATABASE', '__DB_NAME__'),
  username: env('DB_USER', 'postgres'),
  password: env('DB_PASSWORD', ''),
}