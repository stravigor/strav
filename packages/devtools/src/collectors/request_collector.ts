import type { Context, Middleware, Next } from '@strav/http'
import { redact } from '@strav/kernel'
import Collector from './collector.ts'
import DevtoolsManager from '../devtools_manager.ts'
import type EntryStore from '../storage/entry_store.ts'
import type { CollectorOptions } from '../types.ts'

interface RequestCollectorOptions extends CollectorOptions {
  sizeLimit?: number
  /** Extra header/field names whose values should be redacted before storage. */
  redactKeys?: string[]
}

/**
 * Captures HTTP request/response data as devtools entries.
 *
 * Unlike other collectors that listen to Emitter events, this one is a
 * **middleware** — it wraps the request lifecycle to capture timing, headers,
 * body, and response status.
 *
 * @example
 * import { devtools } from '@strav/devtools'
 * router.use(devtools.middleware())
 */
export default class RequestCollector extends Collector {
  private sizeLimit: number
  private extraRedactKeys: string[]

  constructor(store: EntryStore, options: RequestCollectorOptions) {
    super(store, options)
    this.sizeLimit = (options.sizeLimit ?? 64) * 1024 // KB → bytes
    this.extraRedactKeys = options.redactKeys ?? []
  }

  register(): void {
    // No-op — request collection uses middleware, not Emitter
  }

  teardown(): void {
    // No-op
  }

  /**
   * Returns a middleware that records request and response data.
   * The batchId is set on the context so other collectors (query, cache, etc.)
   * can correlate their entries to this request.
   */
  middleware(): Middleware {
    const collector = this

    return async (ctx: Context, next: Next): Promise<Response> => {
      if (!collector.enabled) return next()

      const batchId = crypto.randomUUID()
      ctx.set('_devtools_batch_id', batchId)
      DevtoolsManager.setBatchId(batchId)

      const start = performance.now()
      let response: Response
      let error: Error | undefined

      try {
        response = await next()
      } catch (err) {
        error = err instanceof Error ? err : new Error(String(err))
        throw err
      } finally {
        const duration = performance.now() - start

        const content: Record<string, unknown> = {
          method: ctx.method,
          path: ctx.path,
          url: ctx.url.toString(),
          status: error ? 500 : (response!?.status ?? 500),
          duration: Math.round(duration * 100) / 100,
          ip: ctx.header('x-forwarded-for') ?? ctx.header('x-real-ip') ?? 'unknown',
          memory: Math.round((process.memoryUsage.rss() / 1024 / 1024) * 100) / 100,
        }

        // Request headers — redact secrets before storing. The shared
        // kernel redactor covers Authorization, Cookie, X-Api-Key,
        // X-Auth-Token, X-Csrf-Token, Proxy-Authorization, etc. The
        // collector's redactKeys option extends the deny-list per app.
        const rawRequestHeaders: Record<string, string> = {}
        ctx.headers.forEach((value, key) => {
          rawRequestHeaders[key] = value
        })
        content.requestHeaders = redact(rawRequestHeaders, {
          extraKeys: collector.extraRedactKeys,
        })

        // Response headers
        if (response!) {
          const rawResponseHeaders: Record<string, string> = {}
          response.headers.forEach((value, key) => {
            rawResponseHeaders[key] = value
          })
          content.responseHeaders = redact(rawResponseHeaders, {
            extraKeys: collector.extraRedactKeys,
          })
          content.status = response.status
        }

        if (error) {
          content.error = error.message
        }

        const tags: string[] = []
        tags.push(`status:${content.status}`)
        if (duration > 1000) tags.push('slow')

        // Tag authenticated user if present
        const user = ctx.get<{ id?: unknown }>('user')
        if (user?.id) tags.push(`user:${user.id}`)

        collector.record('request', batchId, content, tags)

        // Emit for recorders (slow requests aggregation)
        DevtoolsManager.emitRequest({
          path: ctx.path,
          method: ctx.method,
          duration: Math.round(duration * 100) / 100,
          status: (content.status as number) ?? 500,
        })

        // Flush immediately — one request = one flush
        collector.flush()
      }

      return response!
    }
  }
}
