import { Seeder } from '@strav/database'
import { UserFactory } from '../factories/user_factory.ts'

export default class UserSeeder extends Seeder {
  async run(): Promise<void> {
    // Create admin user
    await UserFactory.create({
      email: 'admin@example.com',
      name: 'Admin User',
    })

    // Create test users
    await UserFactory.createMany(10)
  }
}