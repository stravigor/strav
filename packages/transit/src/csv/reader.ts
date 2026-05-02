import { CsvParseError } from '../errors.ts'
import type { CsvReadOptions, ReadSource } from '../types.ts'

/**
 * Streaming CSV reader.
 *
 * RFC 4180 subset:
 * - configurable single-character delimiter (default `,`)
 * - double-quote escaping (`""` inside a quoted field becomes `"`)
 * - both `\n` and `\r\n` row separators (mixed within a file is fine)
 * - newlines are allowed inside quoted fields
 * - leading UTF-8 BOM is stripped
 *
 * Memory: the parser only buffers the current field and (when the input
 * arrives in chunks split mid-row) the current row. It does **not** buffer
 * the full file.
 *
 * Yields one parsed row at a time. With `header: true` (default), the first
 * row is consumed as the header and subsequent rows yield `Record<string, string>`.
 * With `header: false`, every row yields as `string[]`.
 *
 * @example
 * for await (const row of readCsv(file.stream())) {
 *   console.log(row.Email, row.Name)
 * }
 */
export async function* readCsv(
  source: ReadSource,
  options: CsvReadOptions = {}
): AsyncIterable<Record<string, string> | string[]> {
  const delimiter = options.delimiter ?? ','
  const quote = options.quote ?? '"'
  const skipEmpty = options.skipEmpty ?? true
  if (delimiter.length !== 1) throw new CsvParseError('delimiter must be a single character')
  if (quote.length !== 1) throw new CsvParseError('quote must be a single character')

  let headers: string[] | undefined
  let firstRow = true
  if (Array.isArray(options.header)) {
    headers = options.header
    firstRow = false
  } else if (options.header === false) {
    firstRow = false
  }

  for await (const row of parseRows(source, delimiter, quote)) {
    if (skipEmpty && row.length === 1 && row[0] === '') continue
    if (firstRow) {
      headers = row
      firstRow = false
      continue
    }
    if (headers) {
      const obj: Record<string, string> = {}
      for (let i = 0; i < headers.length; i++) obj[headers[i]!] = row[i] ?? ''
      yield obj
    } else {
      yield row
    }
  }
}

async function *parseRows(
  source: ReadSource,
  delim: string,
  quote: string
): AsyncIterable<string[]> {
  // Two-state scanner. `inQuotes` tracks whether the cursor is inside a quoted
  // field. `field` accumulates the current field's characters. `row` accumulates
  // fields for the current row. `pendingQuote` handles the `""` escape (when we
  // see one quote we delay deciding until the next char).
  let inQuotes = false
  let pendingQuote = false
  let field = ''
  let row: string[] = []
  let stripBom = true

  for await (const chunk of charsOf(source)) {
    let s = chunk
    if (stripBom) {
      stripBom = false
      if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
    }
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!
      if (pendingQuote) {
        // Just emitted a quote at end of quoted field — disambiguate.
        pendingQuote = false
        if (ch === quote) {
          // Escaped quote inside the field.
          field += quote
          continue
        }
        // Otherwise: the quote really ended the field. Process `ch` normally.
        inQuotes = false
      }
      if (inQuotes) {
        if (ch === quote) {
          pendingQuote = true
          continue
        }
        field += ch
        continue
      }
      if (ch === quote) {
        inQuotes = true
        continue
      }
      if (ch === delim) {
        row.push(field)
        field = ''
        continue
      }
      if (ch === '\r') continue // swallow; LF will close the row
      if (ch === '\n') {
        row.push(field)
        field = ''
        yield row
        row = []
        continue
      }
      field += ch
    }
  }

  // EOF flush. If we ended on a pending quote, treat it as a closing quote.
  if (pendingQuote) {
    pendingQuote = false
    inQuotes = false
  }
  if (inQuotes) {
    throw new CsvParseError('unterminated quoted field at end of input')
  }
  // Emit trailing row only if there's any content. A pure-empty buffer means
  // the file ended on a newline, no trailing row to flush.
  if (field !== '' || row.length > 0) {
    row.push(field)
    yield row
  }
}

async function *charsOf(source: ReadSource): AsyncIterable<string> {
  if (typeof source === 'string') {
    yield source
    return
  }
  if (source instanceof Uint8Array) {
    yield new TextDecoder().decode(source)
    return
  }
  // Either a ReadableStream<Uint8Array> or AsyncIterable<Uint8Array | string>.
  // Bun makes ReadableStreams async-iterable, so the same loop handles both.
  const decoder = new TextDecoder()
  for await (const chunk of source as AsyncIterable<Uint8Array | string>) {
    if (typeof chunk === 'string') yield chunk
    else yield decoder.decode(chunk, { stream: true })
  }
  const tail = decoder.decode()
  if (tail) yield tail
}
