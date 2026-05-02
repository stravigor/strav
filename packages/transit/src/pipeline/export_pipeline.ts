import { writeCsv } from '../csv/writer.ts'
import { writeJsonl } from '../jsonl/writer.ts'
import type { CsvWriteOptions, WriteSink } from '../types.ts'

/**
 * Fluent export pipeline. Pulls from any iterable / async iterable / query
 * builder and serializes rows to a sink.
 *
 * @example
 * await transit.export('csv')
 *   .from(Lead.query().where('status', 'qualified'))
 *   .map(lead => ({ Email: lead.email, Score: lead.score }))
 *   .to(response.body)
 */
export class PendingExport<T = unknown, U = T> {
  private _source?:
    | Iterable<T>
    | AsyncIterable<T>
    | { all(): Promise<T[]> }
    | { run(): Promise<T[]> }
  private _format: 'csv' | 'jsonl' = 'csv'
  private _mappers: ((row: any) => any)[] = []
  private _csvOpts: CsvWriteOptions = {}

  constructor(format: 'csv' | 'jsonl' = 'csv') {
    this._format = format
  }

  from(
    source:
      | Iterable<T>
      | AsyncIterable<T>
      | { all(): Promise<T[]> }
      | { run(): Promise<T[]> }
  ): this {
    this._source = source
    return this
  }

  map<N>(fn: (row: U) => N): PendingExport<T, N> {
    this._mappers.push(fn)
    return this as unknown as PendingExport<T, N>
  }

  csvOptions(opts: CsvWriteOptions): this {
    this._csvOpts = { ...this._csvOpts, ...opts }
    return this
  }

  /** Serialize and write to the sink. Returns the row count. */
  async to(sink: WriteSink): Promise<number> {
    if (!this._source) throw new Error('transit.export: .from(source) is required')
    const iterable = this.iterate()
    if (this._format === 'jsonl') return writeJsonl(iterable, sink)
    return writeCsv(iterable as AsyncIterable<Record<string, unknown> | unknown[]>, sink, this._csvOpts)
  }

  private async *iterate(): AsyncIterable<unknown> {
    const src = this._source!
    let stream: AsyncIterable<T> | Iterable<T>
    if (typeof (src as any)[Symbol.asyncIterator] === 'function') {
      stream = src as AsyncIterable<T>
    } else if (typeof (src as any)[Symbol.iterator] === 'function') {
      stream = src as Iterable<T>
    } else if (typeof (src as any).all === 'function') {
      stream = (await (src as { all(): Promise<T[]> }).all()) as Iterable<T>
    } else if (typeof (src as any).run === 'function') {
      stream = (await (src as { run(): Promise<T[]> }).run()) as Iterable<T>
    } else {
      throw new Error('transit.export: source must be iterable or expose all()/run()')
    }
    for await (const row of stream as AsyncIterable<T>) {
      let value: any = row
      for (const fn of this._mappers) value = fn(value)
      yield value
    }
  }
}
