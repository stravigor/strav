import type {
  DatabaseRepresentation,
  TableDefinition,
  ColumnDefinition,
  ForeignKeyConstraint,
  UniqueConstraint,
  IndexDefinition,
  DefaultValue,
} from '../../schema/database_representation'
import type { PostgreSQLType } from '../../schema/postgres'
import type {
  SchemaDiff,
  EnumDiff,
  TableDiff,
  ColumnDiff,
  ConstraintDiff,
  IndexDiff,
} from './types'

/**
 * Compares two {@link DatabaseRepresentation} objects and produces a
 * structured {@link SchemaDiff} describing the operations needed to
 * transform `actual` into `desired`.
 */
export default class SchemaDiffer {
  diff(desired: DatabaseRepresentation, actual: DatabaseRepresentation): SchemaDiff {
    const enums = this.diffEnums(desired, actual)
    const { tables, constraints, indexes } = this.diffTablesAndDeps(desired, actual)
    return { enums, tables, constraints, indexes }
  }

  // ---------------------------------------------------------------------------
  // Enums
  // ---------------------------------------------------------------------------

  private diffEnums(desired: DatabaseRepresentation, actual: DatabaseRepresentation): EnumDiff[] {
    const diffs: EnumDiff[] = []
    const actualMap = new Map(actual.enums.map(e => [e.name, e]))
    const desiredMap = new Map(desired.enums.map(e => [e.name, e]))

    // Creates and modifications
    for (const [name, desiredEnum] of desiredMap) {
      const actualEnum = actualMap.get(name)
      if (!actualEnum) {
        diffs.push({ kind: 'create', name, values: desiredEnum.values })
      } else {
        const addedValues = desiredEnum.values.filter(v => !actualEnum.values.includes(v))
        if (addedValues.length > 0) {
          diffs.push({ kind: 'modify', name, addedValues })
        }
      }
    }

    // Drops
    for (const [name, actualEnum] of actualMap) {
      if (!desiredMap.has(name)) {
        diffs.push({ kind: 'drop', name, values: actualEnum.values })
      }
    }

    return diffs
  }

  // ---------------------------------------------------------------------------
  // Tables, Constraints, Indexes
  // ---------------------------------------------------------------------------

  private diffTablesAndDeps(
    desired: DatabaseRepresentation,
    actual: DatabaseRepresentation
  ): { tables: TableDiff[]; constraints: ConstraintDiff[]; indexes: IndexDiff[] } {
    const tables: TableDiff[] = []
    const constraints: ConstraintDiff[] = []
    const indexes: IndexDiff[] = []

    const actualMap = new Map(actual.tables.map(t => [t.name, t]))
    const desiredMap = new Map(desired.tables.map(t => [t.name, t]))

    // Creates and modifications
    for (const [name, desiredTable] of desiredMap) {
      const actualTable = actualMap.get(name)
      if (!actualTable) {
        tables.push({ kind: 'create', table: desiredTable })
        // All constraints and indexes from a new table are additions
        this.extractConstraintAdds(name, desiredTable, constraints)
        this.extractIndexAdds(name, desiredTable, indexes)
      } else {
        // Column diff
        const columnDiffs = this.diffColumns(desiredTable, actualTable)
        if (columnDiffs.length > 0) {
          tables.push({ kind: 'modify', tableName: name, columns: columnDiffs })
        }
        // Constraint diff
        this.diffConstraints(name, desiredTable, actualTable, constraints)
        // Index diff
        this.diffIndexes(name, desiredTable, actualTable, indexes)
      }
    }

    // Drops
    for (const [name, actualTable] of actualMap) {
      if (!desiredMap.has(name)) {
        tables.push({ kind: 'drop', table: actualTable })
        // All constraints and indexes from a dropped table
        this.extractConstraintDrops(name, actualTable, constraints)
        this.extractIndexDrops(name, actualTable, indexes)
      }
    }

    return { tables, constraints, indexes }
  }

  // ---------------------------------------------------------------------------
  // Column diff
  // ---------------------------------------------------------------------------

  private diffColumns(desired: TableDefinition, actual: TableDefinition): ColumnDiff[] {
    const diffs: ColumnDiff[] = []
    const actualMap = new Map(actual.columns.map(c => [c.name, c]))
    const desiredMap = new Map(desired.columns.map(c => [c.name, c]))

    for (const [name, desiredCol] of desiredMap) {
      const actualCol = actualMap.get(name)
      if (!actualCol) {
        diffs.push({ kind: 'add', column: desiredCol })
      } else {
        const alter = this.diffSingleColumn(name, desiredCol, actualCol)
        if (alter) diffs.push(alter)
      }
    }

    for (const [name, actualCol] of actualMap) {
      if (!desiredMap.has(name)) {
        diffs.push({ kind: 'drop', column: actualCol })
      }
    }

    return diffs
  }

  private diffSingleColumn(
    name: string,
    desired: ColumnDefinition,
    actual: ColumnDefinition
  ): ColumnDiff | null {
    // Reject migrations that would convert a column between a global SERIAL
    // and a per-tenant sequence (or vice versa). These changes need a manual
    // migration: drop column, recreate as the new type, backfill data.
    if (!!desired.tenantedSequence !== !!actual.tenantedSequence) {
      throw new Error(
        `Cannot migrate column "${name}" between SERIAL/BIGSERIAL and tenantedSerial/tenantedBigSerial automatically. ` +
          `Drop the column and recreate it manually.`
      )
    }

    // Two tenanted-sequence columns of different widths (integer vs bigint)
    // also need manual migration since the trigger's counter is shared with
    // existing rows.
    if (desired.tenantedSequence && actual.tenantedSequence) {
      if (!pgTypesEqual(desired.pgType, actual.pgType)) {
        throw new Error(
          `Cannot change tenantedSerial column "${name}" between INTEGER and BIGINT automatically.`
        )
      }
    }

    const typeChanged = !pgTypesEqual(desired.pgType, actual.pgType)
    const nullableChanged = desired.notNull !== actual.notNull
    const defaultChanged = !defaultsEqual(desired.defaultValue, actual.defaultValue)

    if (!typeChanged && !nullableChanged && !defaultChanged) return null

    return {
      kind: 'alter',
      columnName: name,
      typeChange: typeChanged ? { from: actual.pgType, to: desired.pgType } : undefined,
      nullableChange: nullableChanged ? { from: actual.notNull, to: desired.notNull } : undefined,
      defaultChange: defaultChanged
        ? { from: actual.defaultValue, to: desired.defaultValue }
        : undefined,
    }
  }

  // ---------------------------------------------------------------------------
  // Constraint diff
  // ---------------------------------------------------------------------------

  private diffConstraints(
    tableName: string,
    desired: TableDefinition,
    actual: TableDefinition,
    out: ConstraintDiff[]
  ): void {
    // Foreign keys — match by (columns, referencedTable, referencedColumns)
    const actualFKs = new Set(actual.foreignKeys.map(fkKey))
    const desiredFKs = new Set(desired.foreignKeys.map(fkKey))

    for (const fk of desired.foreignKeys) {
      if (!actualFKs.has(fkKey(fk))) {
        out.push({ kind: 'add_fk', tableName, constraint: fk })
      }
    }
    for (const fk of actual.foreignKeys) {
      if (!desiredFKs.has(fkKey(fk))) {
        out.push({ kind: 'drop_fk', tableName, constraint: fk })
      }
    }

    // Unique constraints — match by sorted columns
    const actualUqs = new Set(actual.uniqueConstraints.map(uqKey))
    const desiredUqs = new Set(desired.uniqueConstraints.map(uqKey))

    for (const uq of desired.uniqueConstraints) {
      if (!actualUqs.has(uqKey(uq))) {
        out.push({ kind: 'add_unique', tableName, constraint: uq })
      }
    }
    for (const uq of actual.uniqueConstraints) {
      if (!desiredUqs.has(uqKey(uq))) {
        out.push({ kind: 'drop_unique', tableName, constraint: uq })
      }
    }
  }

  private extractConstraintAdds(
    tableName: string,
    table: TableDefinition,
    out: ConstraintDiff[]
  ): void {
    for (const fk of table.foreignKeys) {
      out.push({ kind: 'add_fk', tableName, constraint: fk })
    }
    for (const uq of table.uniqueConstraints) {
      out.push({ kind: 'add_unique', tableName, constraint: uq })
    }
  }

  private extractConstraintDrops(
    tableName: string,
    table: TableDefinition,
    out: ConstraintDiff[]
  ): void {
    for (const fk of table.foreignKeys) {
      out.push({ kind: 'drop_fk', tableName, constraint: fk })
    }
    for (const uq of table.uniqueConstraints) {
      out.push({ kind: 'drop_unique', tableName, constraint: uq })
    }
  }

  // ---------------------------------------------------------------------------
  // Index diff
  // ---------------------------------------------------------------------------

  private diffIndexes(
    tableName: string,
    desired: TableDefinition,
    actual: TableDefinition,
    out: IndexDiff[]
  ): void {
    const actualIdxs = new Set(actual.indexes.map(idxKey))
    const desiredIdxs = new Set(desired.indexes.map(idxKey))

    for (const idx of desired.indexes) {
      if (!actualIdxs.has(idxKey(idx))) {
        out.push({ kind: 'add', tableName, index: idx })
      }
    }
    for (const idx of actual.indexes) {
      if (!desiredIdxs.has(idxKey(idx))) {
        out.push({ kind: 'drop', tableName, index: idx })
      }
    }
  }

  private extractIndexAdds(tableName: string, table: TableDefinition, out: IndexDiff[]): void {
    for (const idx of table.indexes) {
      out.push({ kind: 'add', tableName, index: idx })
    }
  }

  private extractIndexDrops(tableName: string, table: TableDefinition, out: IndexDiff[]): void {
    for (const idx of table.indexes) {
      out.push({ kind: 'drop', tableName, index: idx })
    }
  }
}

// ---------------------------------------------------------------------------
// Comparison helpers
// ---------------------------------------------------------------------------

function fkKey(fk: ForeignKeyConstraint): string {
  return `${fk.columns.join(',')}->${fk.referencedTable}(${fk.referencedColumns.join(',')})`
}

function uqKey(uq: UniqueConstraint): string {
  return [...uq.columns].sort().join(',')
}

function idxKey(idx: IndexDefinition): string {
  return `${[...idx.columns].sort().join(',')}_${idx.unique ? 'unique' : 'non_unique'}`
}

/** Deep-compare two PostgreSQL types. */
export function pgTypesEqual(a: PostgreSQLType, b: PostgreSQLType): boolean {
  if (typeof a === 'string' && typeof b === 'string') return a === b
  if (typeof a !== typeof b) return false
  if (typeof a === 'object' && typeof b === 'object') {
    if (a.type !== (b as any).type) return false
    if (a.type === 'custom' && (b as any).type === 'custom') {
      return a.name === (b as any).name
    }
    if (a.type === 'array' && (b as any).type === 'array') {
      return pgTypesEqual(a.element as PostgreSQLType, (b as any).element as PostgreSQLType)
    }
  }
  return false
}

/** Compare two default values for equality. */
export function defaultsEqual(a: DefaultValue | undefined, b: DefaultValue | undefined): boolean {
  if (a === undefined && b === undefined) return true
  if (a === undefined || b === undefined) return false
  if (a.kind !== b.kind) return false
  if (a.kind === 'literal' && b.kind === 'literal') return a.value === b.value
  if (a.kind === 'expression' && b.kind === 'expression') return a.sql === b.sql
  return false
}
