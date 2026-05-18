/**
 * The serialize pass writes through a {@link ByteSink} (spec §3.3). This keeps
 * the document serializer agnostic to whether output is buffered in memory or
 * streamed to a Writable. M1–M3 ship the buffer sink; StreamSink is M12.
 */

export interface ByteSink {
  /** Append bytes. Implementations must not retain the passed array. */
  write(bytes: Uint8Array): void
  /** Total number of bytes written so far (used for xref offsets). */
  readonly length: number
}
