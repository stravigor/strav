import { describe, expect, test } from 'bun:test'
import { readCsv } from '../src/csv/reader.ts'

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const x of iter) result.push(x)
  return result
}

describe('readCsv', () => {
  test('parses a simple file with header by default', async () => {
    const rows = await collect(readCsv('Name,Email\nAlice,alice@x.com\nBob,bob@x.com\n'))
    expect(rows).toEqual([
      { Name: 'Alice', Email: 'alice@x.com' },
      { Name: 'Bob', Email: 'bob@x.com' },
    ])
  })

  test('handles CRLF line endings', async () => {
    const rows = await collect(readCsv('a,b\r\n1,2\r\n3,4\r\n'))
    expect(rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ])
  })

  test('omits trailing newline cleanly (no empty row at EOF)', async () => {
    const rows = await collect(readCsv('a,b\n1,2'))
    expect(rows).toEqual([{ a: '1', b: '2' }])
  })

  test('handles quoted fields with embedded commas', async () => {
    const rows = await collect(readCsv('a,b\n"Hello, world",2\n'))
    expect(rows).toEqual([{ a: 'Hello, world', b: '2' }])
  })

  test('handles escaped double quotes inside quoted fields', async () => {
    const rows = await collect(readCsv('a,b\n"She said ""hi""",2\n'))
    expect(rows).toEqual([{ a: 'She said "hi"', b: '2' }])
  })

  test('handles newlines inside quoted fields', async () => {
    const rows = await collect(readCsv('a,b\n"line1\nline2",2\n'))
    expect(rows).toEqual([{ a: 'line1\nline2', b: '2' }])
  })

  test('strips a leading UTF-8 BOM', async () => {
    const withBom = '﻿a,b\n1,2\n'
    const rows = await collect(readCsv(withBom))
    expect(rows).toEqual([{ a: '1', b: '2' }])
  })

  test('uses an explicit header array (does not consume first row)', async () => {
    const rows = await collect(readCsv('1,2\n3,4\n', { header: ['x', 'y'] }))
    expect(rows).toEqual([
      { x: '1', y: '2' },
      { x: '3', y: '4' },
    ])
  })

  test('emits string[] when header is false', async () => {
    const rows = await collect(readCsv('1,2\n3,4\n', { header: false }))
    expect(rows).toEqual([['1', '2'], ['3', '4']])
  })

  test('skips empty lines by default', async () => {
    const rows = await collect(readCsv('a,b\n1,2\n\n3,4\n'))
    expect(rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ])
  })

  test('honors a custom delimiter', async () => {
    const rows = await collect(readCsv('a;b\n1;2\n', { delimiter: ';' }))
    expect(rows).toEqual([{ a: '1', b: '2' }])
  })

  test('handles input split across stream chunks (mid-quote)', async () => {
    // Simulate a stream that splits the file at an awkward point
    async function* chunks() {
      yield 'a,b\n"Hel'
      yield 'lo,'
      yield 'world",2\n'
    }
    const rows = await collect(readCsv(chunks()))
    expect(rows).toEqual([{ a: 'Hello,world', b: '2' }])
  })

  test('throws on unterminated quoted field', async () => {
    await expect(collect(readCsv('a,b\n"unterminated'))).rejects.toThrow(/unterminated/i)
  })
})
