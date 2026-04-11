import { env } from '@strav/kernel'

export default {
  directory: 'resources/views',
  cache: env.bool('VIEW_CACHE', true),
  assets: ['css/app.css', 'builds/islands.js'],
}