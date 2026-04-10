import 'reflect-metadata'
import { app } from '@strav/kernel'
import { router } from '@strav/http'
import { ConfigProvider, EncryptionProvider } from '@strav/kernel'
import { DatabaseProvider } from '@strav/database'
import { SessionProvider } from '@strav/http'
import { ViewProvider } from '@strav/view'
import BaseModel from '@strav/database/orm/base_model'
import Database from '@strav/database/database/database'
import Server from '@strav/http/server'
import { ExceptionHandler } from '@strav/kernel'
import { IslandBuilder } from '@strav/view'

// Register service providers
app
  .use(new ConfigProvider())
  .use(new DatabaseProvider())
  .use(new EncryptionProvider())
  .use(new SessionProvider())
  .use(new ViewProvider())

// Boot services (loads config, connects database, derives encryption keys, starts sessions)
await app.start()

// Initialize ORM
new BaseModel(app.resolve(Database))

// Build Vue islands for development
if (process.env.NODE_ENV !== 'production') {
  const islands = new IslandBuilder({
    islandsDir: './resources/ts/islands',
    outDir: './public',
    outFile: 'islands.js',
  })
  await islands.build()
  islands.watch() // Auto-rebuild on changes
}

// Configure router
router.useExceptionHandler(new ExceptionHandler(true))

// Load routes
await import('./routes/routes')

// Start HTTP server
app.singleton(Server)
const server = app.resolve(Server)
server.start(router)