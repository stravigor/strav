import { describe, expect, test } from 'bun:test'
import { transit } from '../src/helpers.ts'
import { readCsv } from '../src/csv/reader.ts'
import { readJsonl } from '../src/jsonl/reader.ts'

class StringSink {
  buffer = ''
  write(s: string) { this.buffer += s }
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const x of iter) out.push(x)
  return out
}

describe('PendingExport', () => {
  test('exports an array source as CSV', async () => {
    const sink = new StringSink()
    const count = await transit
      .export('csv')
      .from([
        { Email: 'a@x.com', Name: 'A' },
        { Email: 'b@x.com', Name: 'B' },
      ])
      .to(sink)

    expect(count).toBe(2)
    const back = await collect(readCsv(sink.buffer))
    expect(back).toEqual([
      { Email: 'a@x.com', Name: 'A' },
      { Email: 'b@x.com', Name: 'B' },
    ])
  })

  test('applies map() before serialization', async () => {
    const sink = new StringSink()
    await transit
      .export('csv')
      .from([{ id: 1, score: 80 }, { id: 2, score: 50 }])
      .map(r => ({ ID: r.id, Score: r.score }))
      .to(sink)

    expect(sink.buffer).toBe('ID,Score\n1,80\n2,50\n')
  })

  test('exports as JSONL', async () => {
    const sink = new StringSink()
    await transit.export('jsonl').from([{ a: 1 }, { a: 2 }]).to(sink)
    const back = await collect(readJsonl(sink.buffer))
    expect(back).toEqual([{ a: 1 }, { a: 2 }])
  })

  test('accepts an async iterable source', async () => {
    async function* source() {
      yield { a: 1 }
      yield { a: 2 }
    }
    const sink = new StringSink()
    await transit.export('csv').from(source()).to(sink)
    expect(sink.buffer).toBe('a\n1\n2\n')
  })

  test('accepts a query-builder-like object via .all()', async () => {
    const fakeQuery = { all: async () => [{ a: 1 }, { a: 2 }] }
    const sink = new StringSink()
    await transit.export('csv').from(fakeQuery).to(sink)
    expect(sink.buffer).toBe('a\n1\n2\n')
  })

  test('throws when source is missing', async () => {
    await expect(
      transit.export('csv').to({ write() {} })
    ).rejects.toThrow(/from/)
  })
})
