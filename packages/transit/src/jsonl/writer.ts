import type { WriteSink } from '../types.ts'

/**
 * Stream rows as JSON Lines. Each row is `JSON.stringify`'d and terminated
 * with `\n`. Returns the number of rows written.
 */
export async function writeJsonl(
  rows: Iterable<unknown> | AsyncIterable<unknown>,
  sink: WriteSink,
  opts: { newline?: string } = {}
): Promise<number> {
  const newline = opts.newline ?? '\n'
  const writer = openWriter(sink)
  let count = 0
  try {
    for await (const row of rows as AsyncIterable<unknown>) {
      await writer.write(JSON.stringify(row) + newline)
      count++
    }
  } finally {
    if (writer.close) await writer.close()
  }
  return count
}

function openWriter(sink: WriteSink): { write(s: string): Promise<void> | void; close?(): Promise<void> | void } {
  if (sink instanceof WritableStream) {
    const w = sink.getWriter()
    return {
      write: (s: string) => w.write(s),
      close: () => w.close(),
    }
  }
  return sink as { write(s: string): Promise<void> | void; close?(): Promise<void> | void }
}
