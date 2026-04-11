import type { Context } from '@strav/http'

export default class HomeController {
  async index(ctx: Context) {
    return ctx.view('pages/home', {
      title: 'Welcome',
      message: 'Welcome to your new Strav application!',
    })
  }
}