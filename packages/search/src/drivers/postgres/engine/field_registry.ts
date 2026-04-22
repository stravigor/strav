import type { PgIndexSettings } from '../types.ts'

/** Default searchable column when no `searchableAttributes` are configured. */
export const DEFAULT_TEXT_COLUMN = '_text'

/** FTS5 weight tiers in declaration order. */
const WEIGHT_TIERS = ['A', 'B', 'C', 'D'] as const
type WeightTier = (typeof WEIGHT_TIERS)[number]

/** Postgres column type derived from a sample value, or `text` as the conservative default. */
type PgType = 'text' | 'integer' | 'bigint' | 'double precision' | 'boolean' | 'timestamptz'

export interface TypedColumnSpec {
  name: string
  pgType: PgType
  /** JSONB extraction expression: `(doc->>'name')::pgType` (cast suppressed for text). */
  expression: string
}

/**
 * The schema layout for one index: which document attributes feed which
 * tsvector segment + weight, and which typed columns exist for filter/sort.
 *
 * Mirrors `embedded/engine/field_registry.ts` so the two drivers project
 * documents identically. Differences:
 * - Per-attribute weight tier (A/B/C/D) is explicit.
 * - Typed columns are emitted as `GENERATED ALWAYS AS (...) STORED` SQL.
 */
export class FieldRegistry {
  readonly searchable: string[]
  readonly weights: Map<string, WeightTier>
  readonly filterable: string[]
  readonly sortable: string[]
  readonly typedColumns: TypedColumnSpec[]
  readonly primaryKey: string
  readonly language: string

  constructor(settings?: PgIndexSettings, language = 'english') {
    this.primaryKey = settings?.primaryKey ?? 'id'
    this.language = settings?.language ?? language
    this.searchable =
      settings?.searchableAttributes && settings.searchableAttributes.length > 0
        ? [...settings.searchableAttributes]
        : [DEFAULT_TEXT_COLUMN]

    this.weights = new Map()
    for (let i = 0; i < this.searchable.length; i++) {
      const attr = this.searchable[i]!
      const tier = (settings?.weights?.[attr] ?? WEIGHT_TIERS[Math.min(i, 3)]) as WeightTier
      this.weights.set(attr, tier)
    }

    this.filterable = settings?.filterableAttributes ?? []
    this.sortable = settings?.sortableAttributes ?? []

    const seen = new Set<string>()
    const typed: TypedColumnSpec[] = []
    for (const attr of [...this.filterable, ...this.sortable]) {
      if (seen.has(attr)) continue
      seen.add(attr)
      typed.push({ name: attr, pgType: 'text', expression: `(doc->>${literal(attr)})` })
    }
    this.typedColumns = typed
  }

  get usesDefaultTextColumn(): boolean {
    return this.searchable.length === 1 && this.searchable[0] === DEFAULT_TEXT_COLUMN
  }

  /**
   * Project a document into [text, tier] pairs for tsvector construction.
   * Default mode collapses every string into one A-weighted blob.
   */
  projectFtsSegments(document: Record<string, unknown>): Array<{ text: string; tier: WeightTier }> {
    if (this.usesDefaultTextColumn) {
      return [{ text: collectStrings(document), tier: 'A' }]
    }
    return this.searchable.map(attr => ({
      text: coerceText(document[attr]),
      tier: this.weights.get(attr)!,
    }))
  }

  /** Single string spanning all searchable text (for terms-dict tokenization). */
  concatSearchableText(document: Record<string, unknown>): string {
    return this.projectFtsSegments(document)
      .map(s => s.text)
      .filter(Boolean)
      .join(' ')
  }
}

function literal(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

function coerceText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(v => coerceText(v)).filter(Boolean).join(' ')
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

function collectStrings(document: Record<string, unknown>): string {
  const parts: string[] = []
  for (const value of Object.values(document)) {
    if (typeof value === 'string' && value.length > 0) parts.push(value)
    else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string' && item.length > 0) parts.push(item)
      }
    }
  }
  return parts.join(' ')
}
