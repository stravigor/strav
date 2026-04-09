# Logger

Structured logging backed by [pino](https://getpino.io/) with configurable sinks.

## Setup

The Logger reads its configuration from `config/logging.ts`:

```typescript
// config/logging.ts
export default {
  level: 'info',
  sinks: {
    console: { enabled: true, level: 'debug' },
    file: { enabled: true, level: 'info', path: 'storage/logs/app.log' },
  },
}
```

Each sink runs independently — it can have its own minimum log level. The global `level` sets the floor for the pino instance.

## Usage

The Logger is injectable and provides six log levels.

### Using a service provider (recommended)

```typescript
import { LoggerProvider } from '@strav/kernel'

app.use(new LoggerProvider())
```

The `LoggerProvider` registers `Logger` as a singleton. It depends on the `config` provider.

### Manual setup

```typescript
import { Logger } from '@strav/kernel'

app.singleton(Logger)
const logger = app.resolve(Logger)
```

### Log methods
logger.trace('entering function', { fn: 'processOrder' })
logger.debug('cache miss', { key: 'user:42' })
logger.info('server started', { port: 3000 })
logger.warn('rate limit approaching', { current: 95, max: 100 })
logger.error('request failed', { statusCode: 500, path: '/api/users' })
logger.fatal('database unreachable', { host: 'db.example.com' })
```

Every method accepts an optional context object that gets merged into the structured JSON output.

## Sinks

### ConsoleSink

Outputs to stdout using `pino-pretty` for human-readable development logs.

```typescript
{ enabled: true, level: 'debug' }
```

### FileSink

Writes JSON-formatted log entries to a file. Automatically creates parent directories.

```typescript
{ enabled: true, level: 'info', path: 'storage/logs/app.log' }
```

### Custom sinks

Extend the `LogSink` base class and register it in the sink registry inside `logger.ts`:

```typescript
import { LogSink, type SinkConfig } from '@strav/kernel'

class CustomSink extends LogSink {
  createStream() {
    // return a writable stream
  }
}
```

## Log output

Logs are JSON-formatted (pino default). Each entry includes a timestamp, level, message, and any context fields:

```json
{"level":30,"time":1707753600000,"msg":"server started","port":3000}
```
