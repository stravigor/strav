import defineSchema from '../../../../src/schema/define_schema'
import t from '../../../../src/schema/type_builder'
import { Archetype } from '../../../../src/schema/types'

export default defineSchema('workspace', {
  archetype: Archetype.Entity,
  tenantRegistry: true,
  fields: {
    id: t.uuid().primaryKey(),
    slug: t.string().unique().required(),
    name: t.string().required(),
  },
})
