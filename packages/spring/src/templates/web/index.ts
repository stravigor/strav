import 'reflect-metadata'
import { app } from '@strav/kernel'
import { IslandBuilder, ViewEngine } from '@strav/view'
import { providers } from './start/providers'

// Build islands + CSS before the server starts so they're included in the public/ scan
const builder = new IslandBuilder({
  css: { entry: 'resources/css/app.scss' },
})

// Register service providers
app
  .useProviders(providers)
  .onBooted(async() => {
    // Watch for island and template changes in dev
    if (Bun.env.NODE_ENV !== 'production') {
      builder.watch()
      ViewEngine.instance.watch()
    }
    await builder.build()
  })

// Load routes
await import('./start/routes')

await app.start()