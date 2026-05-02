import { CsvParseError } from '../errors.ts'
import type { CsvWriteOptions, WriteSink } from '../types.ts'

/**
 * Serialize a single row to a CSV line (without trailing newline).
 * Fields containing the delimiter, quote, CR, or LF are wrapped in quotes
 * with embedded quotes doubled.
 */
export function writeCsvRow(values: unknown[], opts: CsvWriteOptions = {}): string {
  const delimiter = opts.delimiter ?? ','
  const quote = opts.quote ?? '"'
  if (delimiter.length !== 1) throw new CsvParseError('delimiter must be a single character')
  if (quote.length !== 1) throw new CsvParseError('quote must be a single character')

  return values.map(v => formatField(v, delimiter, quote)).join(delimiter)
}

function formatField(value: unknown, delimiter: string, quote: string): string {
  if (value === null || value === undefined) return ''
  const s = typeof value === 'string' ? value : String(value)
  const needsQuoting =
    s.includes(delimiter) || s.includes(quote) || s.includes('\n') || s.includes('\r')
  if (!needsQuoting) return s
  return quote + s.split(quote).join(quote + quote) + quote
}

/**
 * Stream rows to a sink as CSV. Header is auto-derived from the first row's
 * keys when `columns` is not supplied.
 *
 * Accepts plain objects (`Record<string, unknown>`) or pre-built arrays.
 *
 * @example
 * await writeCsv(
 *   leads.map(l => ({ Email: l.email, Score: l.score })),
 *   response.body
 * )
 */
export async function writeCsv(
  rows: Iterable<Record<string, unknown> | unknown[]> | AsyncIterable<Record<string, unknown> | unknown[]>,
  sink: WriteSink,
  opts: CsvWriteOptions = {}
): Promise<number> {
  const newline = opts.newline ?? '\n'
  const writeHeader = opts.writeHeader ?? true
  let columns = opts.columns
  let headerWritten = false
  let count = 0

  const writer = openWriter(sink)
  try {
    for await (const row of rows as AsyncIterable<Record<string, unknown> | unknown[]>) {
      if (Array.isArray(row)) {
        if (!headerWritten && writeHeader && columns) {
          await writer.write(writeCsvRow(columns, opts) + newline)
          headerWritten = true
        }
        await writer.write(writeCsvRow(row, opts) + newline)
        count++
        continue
      }
      if (!headerWritten) {
        if (!columns) columns = Object.keys(row)
        if (writeHeader) {
          await writer.write(writeCsvRow(columns, opts) + newline)
        }
        headerWritten = true
      }
      const values = (columns ?? Object.keys(row)).map(c => (row as Record<string, unknown>)[c])
      await writer.write(writeCsvRow(values, opts) + newline)
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
