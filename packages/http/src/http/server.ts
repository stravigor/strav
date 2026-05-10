import { readdirSync, statSync, existsSync } from 'node:fs'
import { join, resolve, normalize, relative } from 'node:path'
import { inject } from '@strav/kernel/core/inject'
import Configuration from '@strav/kernel/config/configuration'
import type Router from './router.ts'
import type { WebSocketData } from './router.ts'

@inject
export default class Server {
  private instance: ReturnType<typeof Bun.serve> | null = null

  constructor(private config: Configuration) {}

  /** Start listening with the given router. */
  start(router: Router): void {
    const port = this.config.get('http.port', 3000) as number
    const hostname = this.config.get('http.host', '0.0.0.0') as string
    const domain = this.config.get('http.domain', 'localhost') as string
    const publicDir = this.config.get('http.public') as string | undefined

    router.setDomain(domain)

    const { staticRoutes, compressedFiles } = publicDir
      ? this.scanPublicDir(publicDir)
      : { staticRoutes: undefined, compressedFiles: undefined }

    const resolvedPublicDir = publicDir ? resolve(publicDir) : null

    this.instance = Bun.serve<WebSocketData>({
      port,
      hostname,
      ...(staticRoutes ? { static: staticRoutes } : {}),
      fetch: async (request: Request, server: import('bun').Server<WebSocketData>) => {
        // Handle static files that may have been added after startup
        if (resolvedPublicDir && (request.method === 'GET' || request.method === 'HEAD')) {
          const url = new URL(request.url)

          // Content negotiation for files with pre-compressed variants
          if (compressedFiles?.has(url.pathname)) {
            return this.serveCompressed(request, resolvedPublicDir, url.pathname)
          }

          // Check for runtime-added files not in the static map
          const filePath = normalize(resolve(resolvedPublicDir + url.pathname))
          if (filePath.startsWith(resolvedPublicDir)) {
            const file = Bun.file(filePath)
            // Only serve if file exists and wasn't already in static routes
            if ((await file.exists()) && !staticRoutes?.[url.pathname]) {
              return new Response(file)
            }
          }
        }

        return router.handle(request, server) as Response | Promise<Response>
      },
      websocket: router.websocketHandler(),
      error(error: Error) {
        console.error('Unhandled server error:', error)
        return new Response('Internal Server Error', { status: 500 })
      },
    } as any)

    console.log(`Server listening on ${this.instance.hostname}:${this.instance.port}`)
  }

  /** Gracefully stop the server. */
  stop(): void {
    this.instance?.stop()
    this.instance = null
  }

  /** OS-assigned port the server is listening on. Throws if not started or bound to a unix socket. */
  get port(): number {
    if (!this.instance) throw new Error('Server not started')
    const port = this.instance.port
    if (port === undefined) throw new Error('Server has no port (likely bound to a unix socket)')
    return port
  }

  /** Hostname the server is bound to. Throws if not started. */
  get hostname(): string {
    if (!this.instance) throw new Error('Server not started')
    return this.instance.hostname ?? '127.0.0.1'
  }

  /**
   * Serve a static file with content-encoding negotiation.
   * Checks for .br and .gz variants and serves the best match.
   */
  private serveCompressed(request: Request, publicDir: string, pathname: string): Response {
    const filePath = normalize(resolve(publicDir + pathname))

    // Safety: ensure we're still inside publicDir
    if (!filePath.startsWith(publicDir)) {
      return new Response('Not Found', { status: 404 })
    }

    const file = Bun.file(filePath)
    const acceptEncoding = request.headers.get('accept-encoding') ?? ''

    if (acceptEncoding.includes('br')) {
      const brPath = filePath + '.br'
      if (existsSync(brPath)) {
        return new Response(Bun.file(brPath), {
          headers: {
            'Content-Encoding': 'br',
            'Content-Type': file.type,
            Vary: 'Accept-Encoding',
          },
        })
      }
    }

    if (acceptEncoding.includes('gzip')) {
      const gzPath = filePath + '.gz'
      if (existsSync(gzPath)) {
        return new Response(Bun.file(gzPath), {
          headers: {
            'Content-Encoding': 'gzip',
            'Content-Type': file.type,
            Vary: 'Accept-Encoding',
          },
        })
      }
    }

    return new Response(file)
  }

  /**
   * Recursively scan a public directory and build a static route map.
   * Files with pre-compressed variants (.gz/.br) are excluded from static routes
   * and handled via content negotiation in the fetch handler instead.
   */
  private scanPublicDir(dir: string): {
    staticRoutes: Record<string, Response>
    compressedFiles: Set<string>
  } {
    const routes: Record<string, Response> = {}
    const compressedFiles = new Set<string>()

    const walk = (currentDir: string): void => {
      let entries: string[]
      try {
        entries = readdirSync(currentDir)
      } catch {
        return
      }

      for (const entry of entries) {
        const fullPath = join(currentDir, entry)
        const stat = statSync(fullPath)

        if (stat.isDirectory()) {
          walk(fullPath)
        } else if (stat.isFile() && !entry.endsWith('.gz') && !entry.endsWith('.br')) {
          const urlPath = '/' + relative(dir, fullPath)
          const hasCompressed = existsSync(fullPath + '.gz') || existsSync(fullPath + '.br')

          if (hasCompressed) {
            // Route through fetch handler for content negotiation
            compressedFiles.add(urlPath)
          } else {
            routes[urlPath] = new Response(Bun.file(fullPath))
          }
        }
      }
    }

    walk(dir)
    return { staticRoutes: routes, compressedFiles }
  }
}
