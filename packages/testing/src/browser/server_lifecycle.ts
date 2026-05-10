import { app, Configuration } from '@strav/kernel'
import { Router, Server } from '@strav/http'

export interface ServerHandle {
  server: Server
  router: Router
  baseUrl: string
  port: number
  hostname: string
}

/**
 * Bind a Bun.serve listener for a router that has already had its routes
 * registered. Forces an ephemeral port (port=0) unless the caller specifies
 * one. The caller owns the lifecycle: call {@link stopListener} to tear down.
 */
export function startListener(router: Router, options: { port?: number; hostname?: string } = {}): ServerHandle {
  const config = app.resolve(Configuration)
  const requestedPort = options.port ?? 0
  const requestedHost = options.hostname ?? '127.0.0.1'

  // Override config so Server.start() picks up our port/host without the
  // caller having to mutate their config files.
  config.set('http.port', requestedPort)
  config.set('http.host', requestedHost)

  if (!app.has(Server)) app.singleton(Server)
  const server = app.resolve(Server)
  server.start(router)

  return {
    server,
    router,
    port: server.port,
    hostname: server.hostname,
    baseUrl: `http://${server.hostname}:${server.port}`,
  }
}

export function stopListener(handle: ServerHandle): void {
  handle.server.stop()
}
