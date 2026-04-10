import { Model, column } from '@strav/database'

export default class User extends Model {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare email: string

  @column()
  declare name: string

  @column()
  declare password_hash: string

  @column()
  declare email_verified_at: Date | null

  @column()
  declare remember_token: string | null

  @column()
  declare created_at: Date

  @column()
  declare updated_at: Date

  @column()
  declare deleted_at: Date | null
}