/**
 * A {@link ByteSink} that streams to a Node `Writable` (spec §3.3) — for
 * HTTP responses or files without buffering the whole PDF in memory.
 *
 * The serialize pass calls `write()` synchronously many times; chunks are
 * handed straight to the stream (Node applies its own backpressure buffering).
 * `done()` ends the stream and resolves once it has fully flushed; a stream
 * error at any point (including during the synchronous write burst, which
 * surfaces asynchronously) makes `done()` reject.
 */

import type { Writable } from 'node:stream'
import type { ByteSink } from './byte_sink.ts'

export class StreamSink implements ByteSink {
  private len = 0
  private err?: Error

  constructor(private readonly out: Writable) {
    // Capture errors that occur during the write burst, before done().
    out.on('error', e => {
      this.err ??= e as Error
    })
  }

  get length(): number {
    return this.len
  }

  write(bytes: Uint8Array): void {
    if (this.err) return
    try {
      // Copy: the serializer may reuse buffers; Node keeps the chunk async.
      // The per-write callback reports failures even when no 'error' event
      // is emitted (some runtimes don't emit one for a failed write).
      this.out.write(Buffer.from(bytes), e => {
        if (e) this.err ??= e
      })
    } catch (e) {
      this.err ??= e as Error
    }
    this.len += bytes.length
  }

  /** End the stream; resolves on flush, rejects on any stream error. */
  done(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.err) return reject(this.err)
      const onError = (e?: Error) => {
        this.out.off('finish', onFinish)
        reject(this.err ?? e ?? new Error('stream error'))
      }
      const onFinish = () => {
        this.out.off('error', onError)
        this.err ? reject(this.err) : resolve()
      }
      this.out.once('error', onError)
      this.out.once('finish', onFinish)
      this.out.end()
    })
  }
}
