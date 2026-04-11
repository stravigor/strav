import 'reflect-metadata'
import { app } from '@strav/kernel'
import { IslandBuilder, ViewEngine } from '@strav/view'
import { providers } from './start/providers'

// Build islands + CSS before the server starts
// Outputs: public/css/app.css (from SCSS) and public/builds/islands.js (Vue components)
const builder = new IslandBuilder({
  css: {
    entry: 'resources/css/app.scss',
    outDir: './public/css',
    outFile: 'app.css'
  },
  outDir: './public/builds',
})
await builder.build()

// Register service providers
app
  .useProviders(providers)
  .onBooted(async() => {
    // Watch for island and template changes in dev
    if (Bun.env.NODE_ENV !== 'production') {
      builder.watch()
      ViewEngine.instance.watch()
    }
  })

await app.start()