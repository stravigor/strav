import { join, resolve } from 'node:path'
import { watch, type FSWatcher } from 'node:fs'

/**
 * Appends content-based hashes to public asset URLs for cache busting.
 *
 * Pre-compute hashes at boot with `add()`, then use the sync `resolve()`
 * in templates via a ViewEngine global.
 *
 * @example
 * ```typescript
 * const assets = new AssetVersioner('./public')
 * await assets.add('/css/app.css')
 *
 * ViewEngine.setGlobal('asset', (path: string) => assets.resolve(path))
 * ```
 *
 * In templates: `{{ asset('/css/app.css') }}` → `/css/app.css?v=abc12345`
 */
export class AssetVersioner {
  private publicDir: string
  private cache = new Map<string, string>()
  private watchers = new Map<string, FSWatcher>()

  constructor(publicDir: string) {
    this.publicDir = resolve(publicDir)
  }

  /**
   * Compute the content hash for a public asset and cache the versioned URL.
   * Returns the versioned URL (e.g. `/css/app.css?v=abc12345`).
   * If the file doesn't exist, caches and returns the path as-is.
   */
  async add(publicPath: string): Promise<string> {
    const filePath = join(this.publicDir, publicPath)
    const file = Bun.file(filePath)

    if (!(await file.exists())) {
      this.cache.set(publicPath, publicPath)
      return publicPath
    }

    const content = new Uint8Array(await file.arrayBuffer())
    const hash = this.computeHash(content)
    const versioned = `${publicPath}?v=${hash}`
    this.cache.set(publicPath, versioned)
    return versioned
  }

  /**
   * Sync lookup — returns the cached versioned URL, or the original path
   * if the asset hasn't been added yet.
   */
  resolve(publicPath: string): string {
    return this.cache.get(publicPath) ?? publicPath
  }

  /**
   * Watch a previously added asset for changes and re-hash automatically.
   * Useful in development when CSS/JS is rebuilt by external watchers.
   */
  async watch(publicPath: string): Promise<void> {
    if (this.watchers.has(publicPath)) return

    const filePath = join(this.publicDir, publicPath)

    // Check if file exists before attempting to watch
    const file = Bun.file(filePath)
    if (!(await file.exists())) {
      console.warn(`[AssetVersioner] Cannot watch non-existent file: ${publicPath} - will use unversioned path`)
      return
    }

    let timeout: ReturnType<typeof setTimeout> | null = null

    try {
      const watcher = watch(filePath, () => {
        // Debounce — file may be written in chunks
        if (timeout) clearTimeout(timeout)
        timeout = setTimeout(() => {
          this.add(publicPath)
        }, 100)
      })

      this.watchers.set(publicPath, watcher)
    } catch (error: any) {
      // Handle any unexpected errors gracefully
      console.warn(`[AssetVersioner] Failed to watch ${publicPath}: ${error.message}`)
    }
  }

  /** Stop all file watchers. */
  close(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close()
    }
    this.watchers.clear()
  }

  private computeHash(content: Uint8Array): string {
    const hasher = new Bun.CryptoHasher('md5')
    hasher.update(content)
    return hasher.digest('hex').slice(0, 8)
  }
}
