import defineSchema from '../schema/define_schema'
import { Archetype } from '../schema/types'
import t from '../schema/type_builder'

/**
 * Built-in default tenant registry schema.
 *
 * Re-export from your app's `database/schemas/` directory if you want the
 * stock layout (`tenant` table with a BIGSERIAL primary key, plus `slug`
 * and `name`):
 *
 * ```ts
 * // database/schemas/tenant.ts
 * export { default } from '@strav/database/schemas/default_tenant'
 * ```
 *
 * To customize, copy the body and edit — e.g. rename to `workspace`,
 * change the PK to `t.serial()` or `t.uuid()`, add additional fields:
 *
 * ```ts
 * import { defineSchema, t, Archetype } from '@strav/database'
 *
 * export default defineSchema('workspace', {
 *   archetype: Archetype.Entity,
 *   tenantRegistry: true,
 *   fields: {
 *     id:   t.serial().primaryKey(),
 *     slug: t.string().unique().required(),
 *     name: t.string().required(),
 *   },
 * })
 * ```
 *
 * Exactly one schema across the registry may set `tenantRegistry: true`.
 */
export default defineSchema('tenant', {
  archetype: Archetype.Entity,
  tenantRegistry: true,
  fields: {
    id: t.bigserial().primaryKey(),
    slug: t.string().unique().required(),
    name: t.string().required(),
  },
})
