import type { ColumnDefinition, DefaultValue } from '../../schema/database_representation'
import type { PostgreSQLType } from '../../schema/postgres'
import { enableRLSStatements, createTenantPolicyStatement } from '../tenant/policies'
import { type TenantIdType, DEFAULT_TENANT_ID_TYPE } from '../tenant/id_type'
import type {
  SchemaDiff,
  GeneratedSql,
  EnumDiff,
  TableDiff,
  ColumnDiff,
  ConstraintDiff,
  IndexDiff,
} from './types'

/**
 * Generates SQL migration statements from a {@link SchemaDiff}.
 *
 * Output is split into four categories matching the migration file structure:
 * enums, tables, constraints, indexes — each with up and down SQL.
 */
export default class SqlGenerator {
  private tenantIdType: TenantIdType

  constructor(tenantIdType: TenantIdType = DEFAULT_TENANT_ID_TYPE) {
    this.tenantIdType = tenantIdType
  }

  generate(diff: SchemaDiff): GeneratedSql {
    return {
      enumsUp: this.generateEnumsUp(diff.enums),
      enumsDown: this.generateEnumsDown(diff.enums),
      tables: this.generateTables(diff.tables),
      constraintsUp: this.generateConstraintsUp(diff.constraints),
      constraintsDown: this.generateConstraintsDown(diff.constraints),
      indexesUp: this.generateIndexesUp(diff.indexes),
      indexesDown: this.generateIndexesDown(diff.indexes),
    }
  }

  // ---------------------------------------------------------------------------
  // Enums
  // ---------------------------------------------------------------------------

  private generateEnumsUp(diffs: EnumDiff[]): string {
    const lines: string[] = []
    for (const d of diffs) {
      if (d.kind === 'create') {
        const vals = d.values.map(v => `'${v}'`).join(', ')
        lines.push(`-- Create enum: ${d.name}`)
        lines.push(`CREATE TYPE "${d.name}" AS ENUM (${vals});\n`)
      } else if (d.kind === 'modify') {
        lines.push(`-- Add values to enum: ${d.name}`)
        for (const v of d.addedValues) {
          lines.push(`ALTER TYPE "${d.name}" ADD VALUE '${v}';`)
        }
        lines.push('')
      } else if (d.kind === 'drop') {
        lines.push(`-- Drop enum: ${d.name}`)
        lines.push(`DROP TYPE IF EXISTS "${d.name}";\n`)
      }
    }
    return lines.join('\n').trim()
  }

  private generateEnumsDown(diffs: EnumDiff[]): string {
    const lines: string[] = []
    for (const d of diffs) {
      if (d.kind === 'create') {
        lines.push(`-- Reverse: drop enum ${d.name}`)
        lines.push(`DROP TYPE IF EXISTS "${d.name}";\n`)
      } else if (d.kind === 'modify') {
        lines.push(`-- Reverse: cannot remove enum values for ${d.name}`)
        lines.push(
          `-- Manual intervention required to remove values: ${d.addedValues.join(', ')}\n`
        )
      } else if (d.kind === 'drop') {
        const vals = d.values.map(v => `'${v}'`).join(', ')
        lines.push(`-- Reverse: recreate enum ${d.name}`)
        lines.push(`CREATE TYPE "${d.name}" AS ENUM (${vals});\n`)
      }
    }
    return lines.join('\n').trim()
  }

  // ---------------------------------------------------------------------------
  // Tables
  // ---------------------------------------------------------------------------

  private generateTables(diffs: TableDiff[]): Map<string, { up: string; down: string }> {
    const result = new Map<string, { up: string; down: string }>()

    for (const d of diffs) {
      if (d.kind === 'create') {
        result.set(d.table.name, {
          up: this.generateCreateTable(
            d.table.name,
            d.table.columns,
            d.table.primaryKey?.columns ?? [],
            d.table.tenanted ?? false
          ),
          down: `-- Drop table: ${d.table.name}\nDROP TABLE IF EXISTS "${d.table.name}" CASCADE;`,
        })
      } else if (d.kind === 'drop') {
        result.set(d.table.name, {
          up: `-- Drop table: ${d.table.name}\nDROP TABLE IF EXISTS "${d.table.name}" CASCADE;`,
          down: this.generateCreateTable(
            d.table.name,
            d.table.columns,
            d.table.primaryKey?.columns ?? [],
            d.table.tenanted ?? false
          ),
        })
      } else if (d.kind === 'modify') {
        result.set(d.tableName, {
          up: this.generateAlterUp(d.tableName, d.columns),
          down: this.generateAlterDown(d.tableName, d.columns),
        })
      }
    }

    return result
  }

  private generateCreateTable(
    name: string,
    columns: ColumnDefinition[],
    pkColumns: string[],
    tenanted: boolean = false
  ): string {
    const lines: string[] = []
    lines.push(`-- Create table: ${name}`)
    lines.push(`CREATE TABLE IF NOT EXISTS "${name}" (`)

    const colDefs: string[] = []
    for (const c of columns) {
      colDefs.push(`  ${columnToSql(c)}`)
    }
    if (pkColumns.length > 0) {
      const pkCols = pkColumns.map(c => `"${c}"`).join(', ')
      colDefs.push(`  CONSTRAINT "pk_${name}" PRIMARY KEY (${pkCols})`)
    }
    lines.push(colDefs.join(',\n'))
    lines.push(');')

    if (tenanted) {
      lines.push('')
      lines.push(`-- Enable row-level security for tenant isolation`)
      for (const stmt of enableRLSStatements(name)) {
        lines.push(stmt)
      }
      lines.push(createTenantPolicyStatement(name, this.tenantIdType))
    }

    return lines.join('\n')
  }

  private generateAlterUp(tableName: string, columns: ColumnDiff[]): string {
    const lines: string[] = []
    lines.push(`-- Modify table: ${tableName}`)

    for (const c of columns) {
      if (c.kind === 'add') {
        lines.push(`ALTER TABLE "${tableName}" ADD COLUMN ${columnToSql(c.column)};`)
      } else if (c.kind === 'drop') {
        lines.push(`ALTER TABLE "${tableName}" DROP COLUMN IF EXISTS "${c.column.name}";`)
      } else if (c.kind === 'alter') {
        if (c.typeChange) {
          const newType = pgTypeToSql(c.typeChange.to)
          lines.push(
            `ALTER TABLE "${tableName}" ALTER COLUMN "${c.columnName}" TYPE ${newType} USING "${c.columnName}"::${newType};`
          )
        }
        if (c.nullableChange) {
          if (c.nullableChange.to) {
            lines.push(`ALTER TABLE "${tableName}" ALTER COLUMN "${c.columnName}" SET NOT NULL;`)
          } else {
            lines.push(`ALTER TABLE "${tableName}" ALTER COLUMN "${c.columnName}" DROP NOT NULL;`)
          }
        }
        if (c.defaultChange) {
          if (c.defaultChange.to !== undefined) {
            lines.push(
              `ALTER TABLE "${tableName}" ALTER COLUMN "${c.columnName}" SET DEFAULT ${defaultValueToSql(c.defaultChange.to)};`
            )
          } else {
            lines.push(`ALTER TABLE "${tableName}" ALTER COLUMN "${c.columnName}" DROP DEFAULT;`)
          }
        }
      }
    }

    return lines.join('\n')
  }

  private generateAlterDown(tableName: string, columns: ColumnDiff[]): string {
    const lines: string[] = []
    lines.push(`-- Reverse modify table: ${tableName}`)

    // Reverse in opposite order
    for (const c of [...columns].reverse()) {
      if (c.kind === 'add') {
        // Reverse of add is drop
        lines.push(`ALTER TABLE "${tableName}" DROP COLUMN IF EXISTS "${c.column.name}";`)
      } else if (c.kind === 'drop') {
        // Reverse of drop is add
        lines.push(`ALTER TABLE "${tableName}" ADD COLUMN ${columnToSql(c.column)};`)
      } else if (c.kind === 'alter') {
        // Reverse each change
        if (c.defaultChange) {
          if (c.defaultChange.from !== undefined) {
            lines.push(
              `ALTER TABLE "${tableName}" ALTER COLUMN "${c.columnName}" SET DEFAULT ${defaultValueToSql(c.defaultChange.from)};`
            )
          } else {
            lines.push(`ALTER TABLE "${tableName}" ALTER COLUMN "${c.columnName}" DROP DEFAULT;`)
          }
        }
        if (c.nullableChange) {
          if (c.nullableChange.from) {
            lines.push(`ALTER TABLE "${tableName}" ALTER COLUMN "${c.columnName}" SET NOT NULL;`)
          } else {
            lines.push(`ALTER TABLE "${tableName}" ALTER COLUMN "${c.columnName}" DROP NOT NULL;`)
          }
        }
        if (c.typeChange) {
          const oldType = pgTypeToSql(c.typeChange.from)
          lines.push(
            `ALTER TABLE "${tableName}" ALTER COLUMN "${c.columnName}" TYPE ${oldType} USING "${c.columnName}"::${oldType};`
          )
        }
      }
    }

    return lines.join('\n')
  }

  // ---------------------------------------------------------------------------
  // Constraints
  // ---------------------------------------------------------------------------

  private generateConstraintsUp(diffs: ConstraintDiff[]): string {
    const lines: string[] = []
    for (const d of diffs) {
      if (d.kind === 'add_fk') {
        const name = `fk_${d.tableName}_${d.constraint.columns.join('_')}`
        const cols = d.constraint.columns.map(c => `"${c}"`).join(', ')
        const refCols = d.constraint.referencedColumns.map(c => `"${c}"`).join(', ')
        lines.push(
          `ALTER TABLE "${d.tableName}" ADD CONSTRAINT "${name}" FOREIGN KEY (${cols}) REFERENCES "${d.constraint.referencedTable}" (${refCols}) ON DELETE ${d.constraint.onDelete} ON UPDATE ${d.constraint.onUpdate};`
        )
      } else if (d.kind === 'drop_fk') {
        const name = `fk_${d.tableName}_${d.constraint.columns.join('_')}`
        lines.push(`ALTER TABLE "${d.tableName}" DROP CONSTRAINT IF EXISTS "${name}";`)
      } else if (d.kind === 'add_unique') {
        const name = `uq_${d.tableName}_${d.constraint.columns.join('_')}`
        const cols = d.constraint.columns.map(c => `"${c}"`).join(', ')
        lines.push(`ALTER TABLE "${d.tableName}" ADD CONSTRAINT "${name}" UNIQUE (${cols});`)
      } else if (d.kind === 'drop_unique') {
        const name = `uq_${d.tableName}_${d.constraint.columns.join('_')}`
        lines.push(`ALTER TABLE "${d.tableName}" DROP CONSTRAINT IF EXISTS "${name}";`)
      }
    }
    return lines.join('\n').trim()
  }

  private generateConstraintsDown(diffs: ConstraintDiff[]): string {
    const lines: string[] = []
    // Reverse: adds become drops, drops become adds
    for (const d of [...diffs].reverse()) {
      if (d.kind === 'add_fk') {
        const name = `fk_${d.tableName}_${d.constraint.columns.join('_')}`
        lines.push(`ALTER TABLE "${d.tableName}" DROP CONSTRAINT IF EXISTS "${name}";`)
      } else if (d.kind === 'drop_fk') {
        const name = `fk_${d.tableName}_${d.constraint.columns.join('_')}`
        const cols = d.constraint.columns.map(c => `"${c}"`).join(', ')
        const refCols = d.constraint.referencedColumns.map(c => `"${c}"`).join(', ')
        lines.push(
          `ALTER TABLE "${d.tableName}" ADD CONSTRAINT "${name}" FOREIGN KEY (${cols}) REFERENCES "${d.constraint.referencedTable}" (${refCols}) ON DELETE ${d.constraint.onDelete} ON UPDATE ${d.constraint.onUpdate};`
        )
      } else if (d.kind === 'add_unique') {
        const name = `uq_${d.tableName}_${d.constraint.columns.join('_')}`
        lines.push(`ALTER TABLE "${d.tableName}" DROP CONSTRAINT IF EXISTS "${name}";`)
      } else if (d.kind === 'drop_unique') {
        const name = `uq_${d.tableName}_${d.constraint.columns.join('_')}`
        const cols = d.constraint.columns.map(c => `"${c}"`).join(', ')
        lines.push(`ALTER TABLE "${d.tableName}" ADD CONSTRAINT "${name}" UNIQUE (${cols});`)
      }
    }
    return lines.join('\n').trim()
  }

  // ---------------------------------------------------------------------------
  // Indexes
  // ---------------------------------------------------------------------------

  private generateIndexesUp(diffs: IndexDiff[]): string {
    const lines: string[] = []
    for (const d of diffs) {
      if (d.kind === 'add') {
        const name = indexName(d.tableName, d.index)
        const cols = d.index.columns.map(c => `"${c}"`).join(', ')
        const unique = d.index.unique ? 'UNIQUE ' : ''
        lines.push(`CREATE ${unique}INDEX IF NOT EXISTS "${name}" ON "${d.tableName}" (${cols});`)
      } else if (d.kind === 'drop') {
        const name = indexName(d.tableName, d.index)
        lines.push(`DROP INDEX IF EXISTS "${name}";`)
      }
    }
    return lines.join('\n').trim()
  }

  private generateIndexesDown(diffs: IndexDiff[]): string {
    const lines: string[] = []
    for (const d of [...diffs].reverse()) {
      if (d.kind === 'add') {
        const name = indexName(d.tableName, d.index)
        lines.push(`DROP INDEX IF EXISTS "${name}";`)
      } else if (d.kind === 'drop') {
        const name = indexName(d.tableName, d.index)
        const cols = d.index.columns.map(c => `"${c}"`).join(', ')
        const unique = d.index.unique ? 'UNIQUE ' : ''
        lines.push(`CREATE ${unique}INDEX IF NOT EXISTS "${name}" ON "${d.tableName}" (${cols});`)
      }
    }
    return lines.join('\n').trim()
  }
}

// ---------------------------------------------------------------------------
// Helpers (exported for testing)
// ---------------------------------------------------------------------------

function indexName(tableName: string, idx: { columns: string[]; unique: boolean }): string {
  const suffix = idx.unique ? '_unique' : ''
  return `idx_${tableName}_${idx.columns.join('_')}${suffix}`
}

/** Render a column definition as a SQL fragment (no trailing comma). */
export function columnToSql(c: ColumnDefinition): string {
  const typeSql = pgTypeToSql(c.pgType, c)
  const parts = [`"${c.name}" ${typeSql}`]

  // Serial types handle NOT NULL and default implicitly
  if (!isSerial(c.pgType)) {
    if (c.notNull) parts.push('NOT NULL')
    if (c.defaultValue !== undefined) parts.push(`DEFAULT ${defaultValueToSql(c.defaultValue)}`)
  }

  return parts.join(' ')
}

/** Convert a PostgreSQLType (+ optional column metadata) to a SQL type string. */
export function pgTypeToSql(pgType: PostgreSQLType, col?: ColumnDefinition): string {
  if (typeof pgType === 'object') {
    if (pgType.type === 'custom') return `"${pgType.name}"`
    if (pgType.type === 'array') return `${pgTypeToSql(pgType.element as PostgreSQLType)}[]`
  }

  // Multi-word types
  const multiWord: Record<string, string> = {
    double_precision: 'DOUBLE PRECISION',
    character_varying: 'CHARACTER VARYING',
    bit_varying: 'BIT VARYING',
  }
  if (typeof pgType === 'string' && pgType in multiWord) {
    return multiWord[pgType]!
  }

  const upper = (pgType as string).toUpperCase()

  // Types with parameters
  if (col) {
    if ((pgType === 'varchar' || pgType === 'character_varying') && col.length) {
      return `VARCHAR(${col.length})`
    }
    if ((pgType === 'char' || pgType === 'character') && col.length) {
      return `CHAR(${col.length})`
    }
    if ((pgType === 'numeric' || pgType === 'decimal') && col.precision !== undefined) {
      if (col.scale !== undefined) return `${upper}(${col.precision},${col.scale})`
      return `${upper}(${col.precision})`
    }
  }

  return upper
}

/** Convert a DefaultValue to its SQL representation. */
export function defaultValueToSql(dv: DefaultValue): string {
  if (dv.kind === 'expression') return dv.sql
  if (dv.value === null) return 'NULL'
  if (typeof dv.value === 'boolean') return dv.value ? 'true' : 'false'
  if (typeof dv.value === 'number') return String(dv.value)
  return `'${dv.value}'`
}

function isSerial(pgType: PostgreSQLType): boolean {
  return pgType === 'serial' || pgType === 'bigserial' || pgType === 'smallserial'
}
