import { Seeder } from '@strav/database'
import UserSeeder from './user_seeder.ts'

export default class DatabaseSeeder extends Seeder {
  async run(): Promise<void> {
    await this.call(UserSeeder)
  }
}