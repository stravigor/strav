import type { Context } from '@strav/http'

export abstract class Controller {
  protected async respond<T>(ctx: Context, data: T, status = 200) {
    return ctx.json(data, status)
  }

  protected async error(ctx: Context, message: string, status = 400) {
    return ctx.json({ error: message }, status)
  }

  protected async notFound(ctx: Context, message = 'Not found') {
    return ctx.json({ error: message }, 404)
  }
}