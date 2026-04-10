import { defineSchema, t, Archetype } from '@strav/database'

export default defineSchema('user', {
  archetype: Archetype.Entity,
  fields: {
    id: t.uuid().primaryKey(),
    email: t.string().email().unique().required(),
    name: t.string().required(),
    password_hash: t.string().required(),
    email_verified_at: t.timestamp().nullable(),
    remember_token: t.string(100).nullable(),
  },
})