import { describe, expect, test } from 'bun:test'
import { transit } from '../src/helpers.ts'
import { TooManyErrorsError } from '../src/errors.ts'

describe('PendingImport', () => {
  test('runs map → validate → dedup → into() pipeline and returns counts', async () => {
    const csv = [
      'Email,Name',
      'alice@x.com,Alice',
      'BOB@X.COM,Bob',
      'alice@x.com,Alice Duplicate',
      ',No email',
      'eve@x.com,Eve',
    ].join('\n') + '\n'

    const captured: any[] = []
    const result = await transit
      .import('csv')
      .from(csv)
      .map(row => ({ email: row.Email.trim().toLowerCase(), name: row.Name }))
      .validate(row => (row.email ? null : 'email required'))
      .dedupBy('email')
      .into(batch => { captured.push(...batch) })
      .run()

    expect(result.processed).toBe(5)
    expect(result.inserted).toBe(3)
    expect(result.skipped).toBe(1) // alice duplicate dropped
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]!.reason).toBe('email required')
    expect(result.errors[0]!.row).toBe(4)
    expect(captured).toEqual([
      { email: 'alice@x.com', name: 'Alice' },
      { email: 'bob@x.com', name: 'Bob' },
      { email: 'eve@x.com', name: 'Eve' },
    ])
  })

  test('map returning null/undefined skips the row', async () => {
    const captured: any[] = []
    const result = await transit
      .import('csv')
      .from('a,b\n1,2\n3,4\n5,6\n')
      .map(row => (row.a === '3' ? null : row))
      .into(batch => { captured.push(...batch) })
      .run()

    expect(result.processed).toBe(3)
    expect(result.inserted).toBe(2)
    expect(result.skipped).toBe(1)
    expect(captured).toHaveLength(2)
  })

  test('JSONL format works through the pipeline', async () => {
    const captured: any[] = []
    const result = await transit
      .import('jsonl')
      .from('{"a":1}\n{"a":2}\n{"a":3}\n')
      .into(batch => { captured.push(...batch) })
      .run()

    expect(result.inserted).toBe(3)
    expect(captured).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }])
  })

  test('maxErrors aborts mid-import via TooManyErrorsError', async () => {
    const promise = transit
      .import('csv')
      .from('a,b\n1,2\n3,4\n5,6\n7,8\n9,10\n')
      .validate(_ => 'always invalid')
      .into(() => {})
      .maxErrors(2)
      .run()

    await expect(promise).rejects.toBeInstanceOf(TooManyErrorsError)
  })

  test('progress callback fires and the final snapshot is done=true', async () => {
    const reports: any[] = []
    await transit
      .import('csv')
      .from('a\n' + Array.from({ length: 50 }, (_, i) => String(i)).join('\n') + '\n')
      .into(() => {})
      .onProgress(p => { reports.push(p) })
      .batch(5)
      .run()

    expect(reports.length).toBeGreaterThan(0)
    expect(reports[reports.length - 1]!.done).toBe(true)
    expect(reports[reports.length - 1]!.processed).toBe(50)
    expect(reports[reports.length - 1]!.inserted).toBe(50)
  })

  test('dedupBy with extractor function', async () => {
    const captured: any[] = []
    const result = await transit
      .import('csv')
      .from('email,domain\na@x.com,x\nb@x.com,x\na@y.com,y\n')
      .dedupBy(row => (row as any).domain)
      .into(batch => { captured.push(...batch) })
      .run()

    expect(result.inserted).toBe(2) // x and y; second 'x' dropped
    expect(captured.map((r: any) => r.domain)).toEqual(['x', 'y'])
  })

  test('header() override', async () => {
    const captured: any[] = []
    await transit
      .import('csv')
      .from('1,2\n3,4\n')
      .header(['x', 'y'])
      .into(batch => { captured.push(...batch) })
      .run()

    expect(captured).toEqual([
      { x: '1', y: '2' },
      { x: '3', y: '4' },
    ])
  })

  test('throws when neither upsertInto nor into is set', async () => {
    await expect(transit.import('csv').from('a\n1\n').run()).rejects.toThrow(/upsertInto|into/)
  })

  test('throws when source is missing', async () => {
    await expect(transit.import('csv').into(() => {}).run()).rejects.toThrow(/from/)
  })

  test('dedupBy aborts when maxDedupKeys is exceeded', async () => {
    // 5 distinct keys but cap at 2 — pipeline should fail with a clear
    // error instead of growing the Set unbounded.
    await expect(
      transit
        .import('csv')
        .from('id\n1\n2\n3\n4\n5\n')
        .dedupBy('id')
        .maxDedupKeys(2)
        .into(() => {})
        .run()
    ).rejects.toThrow(/maxDedupKeys \(2\)/)
  })

  test('maxDedupKeys(Infinity) opts out of the safeguard', async () => {
    const result = await transit
      .import('csv')
      .from('id\n1\n2\n3\n4\n5\n')
      .dedupBy('id')
      .maxDedupKeys(Infinity)
      .into(() => {})
      .run()
    expect(result.processed).toBe(5)
  })

  test('maxDedupKeys rejects non-positive values', () => {
    expect(() => transit.import('csv').maxDedupKeys(0)).toThrow(/positive/)
    expect(() => transit.import('csv').maxDedupKeys(-1)).toThrow(/positive/)
    expect(() => transit.import('csv').maxDedupKeys(NaN)).toThrow(/finite/)
  })
})
