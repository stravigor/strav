import { Emitter, redact } from '@strav/kernel'
import type { Listener } from '@strav/kernel'
import Collector from './collector.ts'
import type EntryStore from '../storage/entry_store.ts'
import type { CollectorOptions } from '../types.ts'

const LOG_LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const

interface LogCollectorOptions extends CollectorOptions {
  level?: string
  /** Extra field names whose values should be redacted before storage. */
  redactKeys?: string[]
}

/**
 * Captures log entries emitted by the Logger.
 *
 * Listens to the `log:entry` event added to the core Logger.
 * Filters by minimum log level (default: 'debug').
 */
export default class LogCollector extends Collector {
  private listener: Listener | null = null
  private minLevelIndex: number
  private getBatchId: () => string
  private extraRedactKeys: string[]

  constructor(store: EntryStore, options: LogCollectorOptions, getBatchId: () => string) {
    super(store, options)
    const level = options.level ?? 'debug'
    this.minLevelIndex = LOG_LEVELS.indexOf(level as (typeof LOG_LEVELS)[number])
    if (this.minLevelIndex === -1) this.minLevelIndex = 1 // default to debug
    this.getBatchId = getBatchId
    this.extraRedactKeys = options.redactKeys ?? []
  }

  register(): void {
    if (!this.enabled) return

    this.listener = (payload: {
      level: string
      msg: string
      context?: Record<string, unknown>
    }) => {
      const levelIndex = LOG_LEVELS.indexOf(payload.level as (typeof LOG_LEVELS)[number])
      if (levelIndex < this.minLevelIndex) return

      const batchId = this.getBatchId()

      const content: Record<string, unknown> = {
        level: payload.level,
        message: payload.msg,
      }

      if (payload.context) {
        // Scrub secrets in the log context before persisting. Default
        // deny-list catches Authorization/Cookie/api_key/etc.; redactKeys
        // option extends it per app.
        content.context = redact(payload.context, { extraKeys: this.extraRedactKeys })
      }

      const tags = [payload.level]
      if (levelIndex >= 4) tags.push('error')

      this.record('log', batchId, content, tags)
    }

    Emitter.on('log:entry', this.listener)
  }

  teardown(): void {
    if (this.listener) {
      Emitter.off('log:entry', this.listener)
      this.listener = null
    }
  }
}
