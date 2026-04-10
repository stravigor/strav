import type { Context } from '@strav/http'
import { Controller } from './controller.ts'
import User from '../models/user.ts'

export default class UserController extends Controller {
  async index(ctx: Context) {
    const users = await User.all()
    return this.respond(ctx, { users })
  }

  async show(ctx: Context) {
    const { id } = ctx.params
    const user = await User.find(id)

    if (!user) {
      return this.notFound(ctx, 'User not found')
    }

    return this.respond(ctx, { user })
  }

  async store(ctx: Context) {
    const { email, name, password } = await ctx.request.json()

    if (!email || !name || !password) {
      return this.error(ctx, 'Email, name, and password are required')
    }

    const user = await User.create({
      id: crypto.randomUUID(),
      email,
      name,
      password_hash: await Bun.password.hash(password),
    })

    return this.respond(ctx, { user }, 201)
  }

  async update(ctx: Context) {
    const { id } = ctx.params
    const user = await User.find(id)

    if (!user) {
      return this.notFound(ctx, 'User not found')
    }

    const { email, name } = await ctx.request.json()

    if (email) user.email = email
    if (name) user.name = name

    await user.save()

    return this.respond(ctx, { user })
  }

  async destroy(ctx: Context) {
    const { id } = ctx.params
    const user = await User.find(id)

    if (!user) {
      return this.notFound(ctx, 'User not found')
    }

    await user.delete()

    return this.respond(ctx, { message: 'User deleted successfully' })
  }
}