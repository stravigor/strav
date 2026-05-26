import defineSchema from '../../../../src/schema/define_schema'
import t from '../../../../src/schema/type_builder'
import { Archetype } from '../../../../src/schema/types'

export default defineSchema('widget', {
  archetype: Archetype.Entity,
  fields: {
    id: t.bigserial().primaryKey(),
    name: t.string().required(),
  },
})
