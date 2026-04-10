#!/usr/bin/env bun
import 'reflect-metadata'
import { app } from '@strav/kernel'
import { ConfigProvider, EncryptionProvider } from '@strav/kernel'
import { DatabaseProvider } from '@strav/database'
import { CliProvider } from '@strav/cli'

// Register service providers
app
  .use(new ConfigProvider())
  .use(new DatabaseProvider())
  .use(new EncryptionProvider())
  .use(new CliProvider())

// Boot services
await app.start()

// Start CLI
const cli = app.resolve('cli')
await cli.handle(process.argv.slice(2))