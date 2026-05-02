import type { ProgressReport } from '../types.ts'

/**
 * Tracks counts during an import. Emits to a single subscriber on each
 * change; subscribers are throttled by a configurable minimum gap in ms so
 * a 100k-row import doesn't fire 100k callbacks.
 */
export class ProgressReporter {
  private processed = 0
  private inserted = 0
  private updated = 0
  private skipped = 0
  private errors = 0
  private subscriber?: (r: ProgressReport) => void | Promise<void>
  private throttleMs: number
  private lastEmit = 0

  constructor(options: { throttleMs?: number } = {}) {
    this.throttleMs = options.throttleMs ?? 100
  }

  on(listener: (r: ProgressReport) => void | Promise<void>): void {
    this.subscriber = listener
  }

  recordInserted(): void {
    this.processed++
    this.inserted++
    void this.maybeEmit()
  }

  recordUpdated(): void {
    this.processed++
    this.updated++
    void this.maybeEmit()
  }

  recordSkipped(): void {
    this.processed++
    this.skipped++
    void this.maybeEmit()
  }

  recordError(): void {
    this.processed++
    this.errors++
    void this.maybeEmit()
  }

  snapshot(done = false): ProgressReport {
    return {
      processed: this.processed,
      inserted: this.inserted,
      updated: this.updated,
      skipped: this.skipped,
      errors: this.errors,
      done,
    }
  }

  async finish(): Promise<void> {
    if (this.subscriber) await this.subscriber(this.snapshot(true))
  }

  private async maybeEmit(): Promise<void> {
    if (!this.subscriber) return
    const now = Date.now()
    if (now - this.lastEmit < this.throttleMs) return
    this.lastEmit = now
    await this.subscriber(this.snapshot(false))
  }
}
