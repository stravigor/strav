import { PendingImport } from './pipeline/import_pipeline.ts'
import { PendingExport } from './pipeline/export_pipeline.ts'

/**
 * Transit — streaming import/export pipelines.
 *
 * @example
 * import { transit } from '@strav/transit'
 *
 * await transit.import('csv')
 *   .from(Bun.file('contacts.csv').stream())
 *   .map(row => ({ email: row.Email.toLowerCase(), name: row.Name }))
 *   .validate(row => row.email.includes('@') ? null : 'invalid email')
 *   .dedupBy('email')
 *   .upsertInto({ table: 'contacts', conflict: 'email' })
 *   .onProgress(p => console.log(p.processed))
 *   .run()
 *
 * await transit.export('jsonl')
 *   .from(Lead.query().where('status', 'qualified'))
 *   .to(response.body)
 */
export const transit = {
  import(format: 'csv' | 'jsonl' = 'csv'): PendingImport {
    return new PendingImport(format)
  },
  export(format: 'csv' | 'jsonl' = 'csv'): PendingExport {
    return new PendingExport(format)
  },
}
