import { Factory } from '@strav/testing'
import User from '../../app/models/user.ts'

export const UserFactory = Factory.define(User, (seq) => ({
  id: crypto.randomUUID(),
  email: `user-${seq}@example.com`,
  name: `User ${seq}`,
  password_hash: '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi', // password
  email_verified_at: new Date(),
  remember_token: null,
}))