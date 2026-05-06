import 'reflect-metadata'
import EncryptionManager from '@strav/kernel/encryption/encryption_manager'
import Collection from './collection'

const PRIMARY_KEY = Symbol('orm:primary')
const REFERENCE_KEY = Symbol('orm:references')
const REFERENCE_META_KEY = Symbol('orm:reference_meta')
const ASSOCIATE_KEY = Symbol('orm:associates')
const CAST_KEY = Symbol('orm:casts')
const ENCRYPT_KEY = Symbol('orm:encrypted')
const ULID_KEY = Symbol('orm:ulid')

/** Per-instance store for lazy-initialized Collection objects. */
const COLLECTION_STORE = Symbol('orm:collection_store')

// ---------------------------------------------------------------------------
// @primary
// ---------------------------------------------------------------------------

/**
 * Property decorator that marks a field as the primary key.
 * BaseModel reads this metadata to build queries with the correct PK column.
 */
export function primary(target: any, propertyKey: string) {
  Reflect.defineMetadata(PRIMARY_KEY, propertyKey, target.constructor)
}

/** Get the primary key property name (camelCase) for a model class. Defaults to 'id'. */
export function getPrimaryKey(target: Function): string {
  return Reflect.getMetadata(PRIMARY_KEY, target) ?? 'id'
}

// ---------------------------------------------------------------------------
// @reference
// ---------------------------------------------------------------------------

export interface ReferenceOptions {
  model: string
  foreignKey: string
  targetPK: string
}

export interface ReferenceMetadata extends ReferenceOptions {
  property: string
}

/**
 * Property decorator that marks a field as a reference object.
 * Reference properties are excluded from database persistence (dehydrate).
 *
 * Can be used as a bare decorator or with options for load() support.
 *
 * @example
 * // Bare (backward-compatible):
 * @reference
 * declare widget: Widget
 *
 * // With options (supports load()):
 * @reference({ model: 'User', foreignKey: 'userId', targetPK: 'id' })
 * declare user: User
 */
export function reference(targetOrOptions: any, propertyKey?: string): any {
  if (propertyKey !== undefined) {
    // Bare decorator: @reference
    addReferenceProperty(targetOrOptions, propertyKey)
    return
  }

  // Factory: @reference({ model, foreignKey, targetPK })
  const options = targetOrOptions as ReferenceOptions
  return function (target: any, propertyKey: string) {
    addReferenceProperty(target, propertyKey)

    const metas: ReferenceMetadata[] = [
      ...(Reflect.getMetadata(REFERENCE_META_KEY, target.constructor) ?? []),
    ]
    metas.push({ property: propertyKey, ...options })
    Reflect.defineMetadata(REFERENCE_META_KEY, metas, target.constructor)
  }
}

function addReferenceProperty(target: any, propertyKey: string): void {
  const refs: string[] = [...(Reflect.getMetadata(REFERENCE_KEY, target.constructor) ?? [])]
  refs.push(propertyKey)
  Reflect.defineMetadata(REFERENCE_KEY, refs, target.constructor)
}

/** Get the list of reference property names for a model class. */
export function getReferences(target: Function): string[] {
  return Reflect.getMetadata(REFERENCE_KEY, target) ?? []
}

/** Get rich @reference metadata (only present when options were used). */
export function getReferenceMeta(target: Function): ReferenceMetadata[] {
  return Reflect.getMetadata(REFERENCE_META_KEY, target) ?? []
}

// ---------------------------------------------------------------------------
// @associate
// ---------------------------------------------------------------------------

export interface AssociateOptions {
  through: string
  foreignKey: string
  otherKey: string
  model: string
  targetPK: string
}

export interface AssociateMetadata extends AssociateOptions {
  property: string
}

/**
 * Property decorator that marks a field as a many-to-many association.
 *
 * Installs a per-instance {@link Collection} accessor on the prototype.
 * The Collection exposes `load()`, `attach()`, `detach()`, `sync()`, plus
 * iteration/length/`toArray()`. Loaded rows are plain camelCase objects.
 *
 * @example
 * @associate({ through: 'team_user', foreignKey: 'team_id', otherKey: 'user_pid', model: 'User', targetPK: 'pid' })
 * declare members: Collection<User>
 *
 * await team.members.load()
 * await team.members.attach(user)
 * await team.members.attach([u1, u2], { role: 'admin' })
 * await team.members.detach(user)
 * await team.members.sync([u1, u2])
 * for (const m of team.members) { ... }
 */
export function associate(options: AssociateOptions) {
  return function (target: any, propertyKey: string) {
    const meta: AssociateMetadata = { property: propertyKey, ...options }

    const assocs: AssociateMetadata[] = [
      ...(Reflect.getMetadata(ASSOCIATE_KEY, target.constructor) ?? []),
    ]
    assocs.push(meta)
    Reflect.defineMetadata(ASSOCIATE_KEY, assocs, target.constructor)

    Object.defineProperty(target, propertyKey, {
      configurable: true,
      enumerable: false,
      get(this: any) {
        const store: Map<string, Collection<any>> =
          this[COLLECTION_STORE] ??
          (Object.defineProperty(this, COLLECTION_STORE, {
            value: new Map(),
            enumerable: false,
            writable: false,
          }),
          this[COLLECTION_STORE])
        let c = store.get(propertyKey)
        if (!c) {
          c = new Collection(this, meta)
          store.set(propertyKey, c)
        }
        return c
      },
    })
  }
}

/** Get all @associate metadata for a model class. */
export function getAssociates(target: Function): AssociateMetadata[] {
  return Reflect.getMetadata(ASSOCIATE_KEY, target) ?? []
}

// ---------------------------------------------------------------------------
// @cast
// ---------------------------------------------------------------------------

export interface CastDefinition {
  get: (dbValue: unknown) => unknown
  set: (appValue: unknown) => unknown
}

const BUILT_IN_CASTS: Record<string, CastDefinition> = {
  json: {
    get: v => (typeof v === 'string' ? JSON.parse(v) : v),
    set: v => JSON.stringify(v),
  },
  boolean: {
    get: v => {
      if (typeof v === 'boolean') return v
      if (typeof v === 'number') return v !== 0
      if (typeof v === 'string') return v === 'true' || v === '1'
      return Boolean(v)
    },
    set: v => Boolean(v),
  },
  number: {
    get: v => Number(v),
    set: v => Number(v),
  },
  integer: {
    get: v => Math.trunc(Number(v)),
    set: v => Math.trunc(Number(v)),
  },
  string: {
    get: v => String(v),
    set: v => String(v),
  },
  bigint: {
    get: v => {
      if (typeof v === 'bigint')
        return v <= Number.MAX_SAFE_INTEGER && v >= Number.MIN_SAFE_INTEGER ? Number(v) : String(v)
      return Number(v)
    },
    set: v => (typeof v === 'bigint' ? String(v) : v),
  },
}

/**
 * Property decorator that defines type casting between DB and application values.
 * Applied automatically during hydration (DB → model) and dehydration (model → DB).
 *
 * @example
 * // Bare (defaults to JSON):
 * @cast
 * declare state: CanvasState
 *
 * // Named built-in type ('json' | 'boolean' | 'number' | 'integer' | 'string'):
 * @cast('json')
 * declare metadata: SomeType
 *
 * // Custom get/set:
 * @cast({ get: (v) => new Money(v as number), set: (v: Money) => v.toCents() })
 * declare price: Money
 */
export function cast(targetOrTypeOrDef: any, propertyKey?: string): any {
  if (propertyKey !== undefined) {
    // Bare decorator: @cast
    addCastMetadata(targetOrTypeOrDef, propertyKey, BUILT_IN_CASTS.json!)
    return
  }

  // Factory with string type: @cast('json')
  if (typeof targetOrTypeOrDef === 'string') {
    const castDef = BUILT_IN_CASTS[targetOrTypeOrDef]
    if (!castDef) {
      throw new Error(
        `Unknown cast type "${targetOrTypeOrDef}". Available: ${Object.keys(BUILT_IN_CASTS).join(', ')}`
      )
    }
    return function (target: any, propertyKey: string) {
      addCastMetadata(target, propertyKey, castDef)
    }
  }

  // Factory with custom { get, set }: @cast({ get: ..., set: ... })
  const def = targetOrTypeOrDef as CastDefinition
  return function (target: any, propertyKey: string) {
    addCastMetadata(target, propertyKey, def)
  }
}

function addCastMetadata(target: any, propertyKey: string, castDef: CastDefinition): void {
  if (isLikelyDateTimeField(propertyKey)) {
    console.warn(
      `Warning: @cast applied to DateTime field "${propertyKey}" on ${target.constructor.name}. ` +
      `This may interfere with automatic DateTime conversion. ` +
      `Consider using DateTime-specific handling instead of generic @cast.`
    )
  }

  const casts = new Map<string, CastDefinition>(
    Reflect.getMetadata(CAST_KEY, target.constructor) ?? []
  )
  casts.set(propertyKey, castDef)
  Reflect.defineMetadata(CAST_KEY, casts, target.constructor)
}

function isLikelyDateTimeField(propertyKey: string): boolean {
  const dateTimeFieldPatterns = [
    /createdAt/i,
    /updatedAt/i,
    /deletedAt/i,
    /timestamp/i,
    /.*At$/,
    /.*Date$/,
    /.*Time$/,
  ]
  return dateTimeFieldPatterns.some(pattern => pattern.test(propertyKey))
}

/** Get all @cast metadata for a model class as a Map<propertyName, CastDefinition>. */
export function getCasts(target: Function): Map<string, CastDefinition> {
  return Reflect.getMetadata(CAST_KEY, target) ?? new Map()
}

// ---------------------------------------------------------------------------
// @encrypt
// ---------------------------------------------------------------------------

/**
 * Property decorator that encrypts a field before database storage and
 * decrypts it on hydration. Uses AES-256-GCM via EncryptionManager.
 *
 * The database column **must** be TEXT to avoid truncating the encrypted payload.
 *
 * Internally registers a CastDefinition so hydrateFrom/dehydrate handle it
 * automatically. Encrypted fields are excluded from toJSON() output.
 *
 * @example
 * @encrypt
 * declare ssn: string
 */
export function encrypt(target: any, propertyKey: string) {
  addCastMetadata(target, propertyKey, {
    get: v => EncryptionManager.decrypt(v as string),
    set: v => EncryptionManager.encrypt(String(v)),
  })

  const fields: string[] = [...(Reflect.getMetadata(ENCRYPT_KEY, target.constructor) ?? [])]
  fields.push(propertyKey)
  Reflect.defineMetadata(ENCRYPT_KEY, fields, target.constructor)
}

/** Get the list of @encrypt-decorated property names for a model class. */
export function getEncrypted(target: Function): string[] {
  return Reflect.getMetadata(ENCRYPT_KEY, target) ?? []
}

// ---------------------------------------------------------------------------
// @ulid
// ---------------------------------------------------------------------------

/**
 * Property decorator that marks a field as a ULID (Universally Unique
 * Lexicographically Sortable Identifier). ULIDs are auto-generated during
 * insert if the field value is not set.
 *
 * @example
 * @ulid
 * declare id: string
 */
export function ulid(target: any, propertyKey: string) {
  const fields: string[] = [...(Reflect.getMetadata(ULID_KEY, target.constructor) ?? [])]
  fields.push(propertyKey)
  Reflect.defineMetadata(ULID_KEY, fields, target.constructor)
}

/** Get the list of @ulid-decorated property names for a model class. */
export function getUlids(target: Function): string[] {
  return Reflect.getMetadata(ULID_KEY, target) ?? []
}
