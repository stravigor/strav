import type { Context } from '@strav/http'
import { Controller } from './controller.ts'
import User from '../models/user.ts'

export default class HomeController extends Controller {
  async index(ctx: Context) {
    const userCount = await User.count()

    return ctx.view('pages/home', {
      title: 'Welcome to __PROJECT_NAME__',
      userCount,
      message: 'Welcome to your new Strav application!',
    })
  }

  async users(ctx: Context) {
    const users = await User.all()

    return ctx.view('pages/users', {
      title: 'Users',
      users,
    })
  }
}