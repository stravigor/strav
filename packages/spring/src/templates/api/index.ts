import 'reflect-metadata'
import { app } from '@strav/kernel'
import { providers } from './start/providers'

// Register service providers
app.useProviders(providers)

// Load routes
await import('./start/routes')

await app.start()