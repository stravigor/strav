/** Types of entries that collectors produce. */
export type EntryType =
  | 'request'
  | 'query'
  | 'exception'
  | 'log'
  | 'job'
  | 'cache'
  | 'mail'
  | 'event'
  | 'schedule'

/** A single recorded devtools entry, ready for storage. */
export interface DevtoolsEntry {
  uuid: string
  batchId: string
  type: EntryType
  familyHash: string | null
  content: Record<string, unknown>
  tags: string[]
  createdAt: Date
}

/** A row from the _strav_devtools_entries table. */
export interface EntryRecord {
  id: number
  uuid: string
  batchId: string
  type: EntryType
  familyHash: string | null
  content: Record<string, unknown>
  tags: string[]
  createdAt: Date
}

/** Aggregate function names stored in the aggregates table. */
export type AggregateFunction = 'count' | 'min' | 'max' | 'sum' | 'avg'

/** A row from the _strav_devtools_aggregates table. */
export interface AggregateRecord {
  id: number
  bucket: number
  period: number
  type: string
  key: string
  aggregate: AggregateFunction
  value: number
  count: number | null
}

/** Configuration shape for the devtools package. */
export interface DevtoolsConfig {
  enabled: boolean
  routes: {
    /** Route group aliases for devtools endpoints */
    aliases: {
      /** Dashboard frontend routes */
      dashboard: string
      /** API endpoints for dashboard data */
      api: string
    }
    /** Optional subdomain for devtools routes */
    subdomain?: string
  }
  storage: {
    pruneAfter: number
  }
  collectors: {
    request: { enabled: boolean; sizeLimit: number }
    query: { enabled: boolean; slow: number }
    exception: { enabled: boolean }
    log: { enabled: boolean; level: string }
    job: { enabled: boolean }
  }
  recorders: {
    slowRequests: { enabled: boolean; threshold: number; sampleRate: number }
    slowQueries: { enabled: boolean; threshold: number; sampleRate: number }
  }
}

/** Collector configuration passed to each collector. */
export interface CollectorOptions {
  enabled: boolean
  [key: string]: unknown
}

/** Recorder configuration passed to each recorder. */
export interface RecorderOptions {
  enabled: boolean
  threshold?: number
  sampleRate?: number
}
