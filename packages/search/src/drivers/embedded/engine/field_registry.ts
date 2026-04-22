import type { IndexSettings } from '../../../types.ts'

/** The default searchable column name used when no `searchableAttributes` are configured. */
export const DEFAULT_TEXT_COLUMN = '_text'

/**
 * The schema layout for one index: which document attributes feed which FTS5
 * column and which typed `documents` columns exist for filtering / sorting.
 *
 * When a caller doesn't declare `searchableAttributes`, we fall back to a
 * single `_text` column that concatenates every string-valued field at
 * indexing time. Users who want per-field weights opt in by passing
 * `IndexSettings`.
 */
export class FieldRegistry {
  /** FTS5 columns in declaration order — also the order BM25 weights apply in. */
  readonly searchable: string[]
  /** Filterable attributes — materialized as typed columns on `documents`. */
  readonly filterable: string[]
  /** Sortable attributes — materialized as typed columns on `documents`. */
  readonly sortable: string[]
  /** Union of filterable + sortable, deduplicated. */
  readonly typedColumns: string[]
  /** Primary key field name — defaults to 'id'. */
  readonly primaryKey: string

  constructor(settings?: IndexSettings) {
    this.primaryKey = settings?.primaryKey ?? 'id'
    this.searchable =
      settings?.searchableAttributes && settings.searchableAttributes.length > 0
        ? [...settings.searchableAttributes]
        : [DEFAULT_TEXT_COLUMN]
    this.filterable = settings?.filterableAttributes ?? []
    this.sortable = settings?.sortableAttributes ?? []
    this.typedColumns = Array.from(new Set([...this.filterable, ...this.sortable]))
  }

  /** Whether this registry uses the synthesised `_text` column. */
  get usesDefaultTextColumn(): boolean {
    return this.searchable.length === 1 && this.searchable[0] === DEFAULT_TEXT_COLUMN
  }

  /**
   * Project a document into the values that go into the FTS5 row.
   * For default mode, concatenate every string-valued field.
   * For declared mode, pick each named attribute (coerced to string).
   */
  projectFtsValues(document: Record<string, unknown>): string[] {
    if (this.usesDefaultTextColumn) {
      const parts: string[] = []
      for (const value of Object.values(document)) {
        if (typeof value === 'string' && value.length > 0) parts.push(value)
        else if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === 'string' && item.length > 0) parts.push(item)
          }
        }
      }
      return [parts.join(' ')]
    }

    return this.searchable.map(attr => coerceText(document[attr]))
  }

  /**
   * Project a document into the typed-column values stored on `documents`.
   * Returned in the same order as `typedColumns`.
   */
  projectTypedValues(document: Record<string, unknown>): unknown[] {
    return this.typedColumns.map(attr => coerceTyped(document[attr]))
  }

  /**
   * Concatenate every searchable attribute into one long string suitable for
   * tokenization (used for terms-dictionary maintenance).
   */
  concatSearchableText(document: Record<string, unknown>): string {
    return this.projectFtsValues(document).join(' ')
  }
}

function coerceText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value.map(v => coerceText(v)).filter(Boolean).join(' ')
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function coerceTyped(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return JSON.stringify(value)
  if (typeof value === 'object') return JSON.stringify(value)
  return value
}
