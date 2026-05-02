import type { ReadSource } from '../types.ts'

/**
 * Streaming JSONL (JSON Lines) reader.
 *
 * One JSON value per line, separated by `\n` or `\r\n`. Empty / whitespace-only
 * lines are skipped. Invalid JSON throws on the line that fails — caller can
 * wrap individual rows in try/catch via the import pipeline's row-level error
 * handling.
 *
 * @example
 * for await (const obj of readJsonl(file.stream())) {
 *   console.log(obj.email)
 * }
 */
export async function* readJsonl<T = unknown>(source: ReadSource): AsyncIterable<T> {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of toIterable(source)) {
    if (typeof chunk === 'string') buffer += chunk
    else buffer += decoder.decode(chunk, { stream: true })

    let nl = buffer.indexOf('\n')
    while (nl !== -1) {
      const raw = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
      if (line.trim() !== '') yield JSON.parse(line) as T
      nl = buffer.indexOf('\n')
    }
  }
  buffer += decoder.decode()
  if (buffer.trim() !== '') {
    const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
    yield JSON.parse(line) as T
  }
}

async function* toIterable(source: ReadSource): AsyncIterable<Uint8Array | string> {
  if (typeof source === 'string') {
    yield source
    return
  }
  if (source instanceof Uint8Array) {
    yield source
    return
  }
  for await (const chunk of source as AsyncIterable<Uint8Array | string>) {
    yield chunk
  }
}
