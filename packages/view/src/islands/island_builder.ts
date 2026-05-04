import { resolve, join, dirname, basename } from 'node:path'
import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  watch as fsWatch,
  type FSWatcher,
} from 'node:fs'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'
import { vueSfcPlugin } from './vue_plugin.ts'
import ViewEngine from '../engine.ts'
import type { BunPlugin } from 'bun'

// Router type for route injection (optional dependency)
interface Router {
  getAllRoutes(): readonly {
    name?: string
    method: string
    pattern: string
  }[]
}

export interface CssOptions {
  /**
   * CSS entry configuration. Supports:
   * - string: Single entry file (backward compatible)
   * - string[]: Multiple entry files with auto-generated output names
   * - Record<string, string>: Named entries with explicit keys
   */
  entry: string | string[] | Record<string, string>
  /** Output directory. Default: './public/css' */
  outDir?: string
  /** Base URL path for the CSS files. Default: '/css/' */
  basePath?: string
}

interface CssEntry {
  /** Unique key for this CSS entry */
  key: string
  /** Source file path */
  src: string
  /** Output filename */
  outFile: string
  /** Output directory */
  outDir: string
  /** Base URL path */
  basePath: string
  /** Source label that contributed this entry (for diagnostics) */
  sourceLabel: string
  /** Version hash */
  version?: string
}

/**
 * A source of Vue island components and optional CSS.
 *
 * Sources are merged into a single bundle. At most one source may omit a
 * `namespace` — that source becomes the "root" (its components are addressed
 * unprefixed, e.g. `<vue:counter/>`). All other sources must declare a
 * namespace to scope their component names (e.g. `<vue:auth/login-form/>`).
 */
export interface IslandSource {
  /** Directory of `.vue` files. Absolute or CWD-relative. */
  islandsDir: string
  /** Component-name prefix. Required for all but one source. */
  namespace?: string
  /** CSS entries this source contributes. Same shape as `CssOptions.entry`. */
  css?: CssOptions['entry']
  /** Output directory for this source's CSS. Falls back to top-level CSS outDir. */
  cssOutDir?: string
  /** Base URL path for this source's CSS. Falls back to top-level CSS basePath. */
  cssBasePath?: string
  /** Display label for diagnostics. Auto-derived if omitted. */
  label?: string
}

interface ResolvedSource extends IslandSource {
  /** Always absolute after normalization. */
  islandsDir: string
  /** Always set after normalization. */
  label: string
  /** Set when the source comes from a package. */
  packageName?: string
}

export interface IslandBuilderOptions {
  /** Directory containing .vue SFC files. Default: './resources/islands'. Legacy single-source option. */
  islandsDir?: string
  /** Multiple island sources merged into one bundle. */
  sources?: IslandSource[]
  /** Package names whose `strav.islands` manifest should contribute sources. */
  packages?: string[]
  /** Directory to resolve `packages` from. Default: process.cwd(). */
  packagesFrom?: string
  /** Watch package sources too (for workspace-symlinked vendor packages). Default: false. */
  watchPackages?: boolean
  /** Directory where the bundle is output. Default: './public/builds' */
  outDir?: string
  /** Output filename. Default: 'islands.js' */
  outFile?: string
  /** Enable minification. Default: true in production */
  minify?: boolean
  /** Enable pre-compression (gzip + brotli). Default: true */
  compress?: boolean
  /** Base URL path for the islands script. Default: '/builds/' */
  basePath?: string
  /** Sass CSS compilation options. Requires `sass` package as a peer dependency. */
  css?: CssOptions
}

export interface IslandManifest {
  file: string
  version: string
  src: string
  size: number
  gzip?: number
  brotli?: number
}

interface DiscoveredIsland {
  name: string
  path: string
  source: ResolvedSource
}

interface DiscoveredSetup {
  path: string
  label: string
}

const WATCH_DEBOUNCE_MS = 50

export class IslandBuilder {
  private sources: ResolvedSource[]
  private outDir: string
  private outFile: string
  private minify: boolean
  private compress: boolean
  private basePath: string
  private watchPackages: boolean
  private watchers: Map<string, FSWatcher> = new Map()
  private cssEntries: Map<string, CssEntry> = new Map()
  private cssWatchers: Map<string, FSWatcher> = new Map()
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null
  private cssRebuildTimer: ReturnType<typeof setTimeout> | null = null
  private _version: string | null = null
  private _manifest: IslandManifest | null = null
  private router: Router | null = null
  private defaultCssOutDir: string
  private defaultCssBasePath: string
  private packagesFrom: string

  constructor(options: IslandBuilderOptions = {}) {
    this.outDir = resolve(options.outDir ?? './public/builds')
    this.outFile = options.outFile ?? 'islands.js'
    this.minify = options.minify ?? Bun.env.NODE_ENV === 'production'
    this.compress = options.compress ?? true
    this.basePath = options.basePath ?? '/builds/'
    this.watchPackages = options.watchPackages ?? false
    this.defaultCssOutDir = resolve(options.css?.outDir ?? './public/css')
    this.defaultCssBasePath = options.css?.basePath ?? '/css/'
    this.packagesFrom = options.packagesFrom ?? process.cwd()

    this.sources = this.buildSources(options)
    this.populateCssEntries(options.css?.entry)
  }

  /** Resolve all sources from options into a normalized list. */
  private buildSources(options: IslandBuilderOptions): ResolvedSource[] {
    const sources: ResolvedSource[] = []

    // 1. Explicit sources first
    for (const src of options.sources ?? []) {
      sources.push(this.normalizeSource(src))
    }

    // 2. Legacy `islandsDir` (or default 'resources/islands') becomes the anonymous source
    //    if no anonymous source already exists.
    const hasAnonymous = sources.some(s => !s.namespace)
    const wantsLegacySource =
      options.islandsDir !== undefined ||
      (sources.length === 0 && options.packages === undefined)

    if (!hasAnonymous && wantsLegacySource) {
      sources.unshift(
        this.normalizeSource({
          islandsDir: options.islandsDir ?? './resources/islands',
          label: 'app',
        })
      )
    }

    // 3. Package-declared sources
    for (const name of options.packages ?? []) {
      sources.push(this.resolvePackageSource(name))
    }

    this.validateSources(sources)
    return sources
  }

  private normalizeSource(src: IslandSource): ResolvedSource {
    const islandsDir = resolve(src.islandsDir)
    const label = src.label ?? (src.namespace ? src.namespace : islandsDir)
    return { ...src, islandsDir, label }
  }

  private validateSources(sources: ResolvedSource[]): void {
    const anonymous = sources.filter(s => !s.namespace)
    if (anonymous.length > 1) {
      throw new Error(
        `[islands] Only one source may omit 'namespace' (the root app). Found:\n` +
          anonymous.map(s => `  - ${s.label} (${s.islandsDir})`).join('\n')
      )
    }

    const seen = new Map<string, ResolvedSource>()
    for (const src of sources) {
      if (!src.namespace) continue
      const prior = seen.get(src.namespace)
      if (prior) {
        throw new Error(
          `[islands] Duplicate namespace "${src.namespace}":\n` +
            `  - ${prior.label} (${prior.islandsDir})\n` +
            `  - ${src.label} (${src.islandsDir})`
        )
      }
      seen.set(src.namespace, src)
    }
  }

  /** Read a package's `strav.islands` manifest and return a resolved source. */
  private resolvePackageSource(name: string): ResolvedSource {
    let pkgJsonPath: string
    try {
      pkgJsonPath = Bun.resolveSync(`${name}/package.json`, this.packagesFrom)
    } catch (err) {
      throw new Error(
        `[islands] Cannot resolve package "${name}/package.json" from ${this.packagesFrom}. ` +
          `Is the package installed? (${(err as Error).message})`
      )
    }

    const pkgRoot = dirname(pkgJsonPath)
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
    const manifest = pkg?.strav?.islands

    if (!manifest) {
      throw new Error(
        `[islands] Package "${name}" has no "strav.islands" field in package.json.\n` +
          `Add: { "strav": { "islands": { "namespace": "...", "dir": "./islands" } } }`
      )
    }
    if (typeof manifest.namespace !== 'string' || !manifest.namespace) {
      throw new Error(`[islands] Package "${name}" must declare strav.islands.namespace`)
    }
    if (typeof manifest.dir !== 'string' || !manifest.dir) {
      throw new Error(`[islands] Package "${name}" must declare strav.islands.dir`)
    }

    return {
      islandsDir: resolve(pkgRoot, manifest.dir),
      namespace: manifest.namespace,
      css: this.resolveCssRelativeTo(manifest.css, pkgRoot),
      cssOutDir: manifest.cssOutDir,
      cssBasePath: manifest.cssBasePath,
      label: name,
      packageName: name,
    }
  }

  /** Resolve all CSS paths in an entry shape relative to a base directory. */
  private resolveCssRelativeTo(
    entry: CssOptions['entry'] | undefined,
    base: string
  ): CssOptions['entry'] | undefined {
    if (entry === undefined) return undefined
    if (typeof entry === 'string') return resolve(base, entry)
    if (Array.isArray(entry)) return entry.map(e => resolve(base, e))
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(entry)) out[k] = resolve(base, v)
    return out
  }

  /** Walk all sources and add their CSS entries to the global map. */
  private populateCssEntries(topLevelEntry?: CssOptions['entry']): void {
    // Top-level CSS attaches to the anonymous source (or stands alone if there isn't one).
    if (topLevelEntry !== undefined) {
      const anonymous = this.sources.find(s => !s.namespace)
      this.addCssEntries(
        topLevelEntry,
        undefined,
        anonymous?.label ?? 'top-level',
        this.defaultCssOutDir,
        this.defaultCssBasePath
      )
    }

    for (const source of this.sources) {
      if (source.css === undefined) continue
      this.addCssEntries(
        source.css,
        source.namespace,
        source.label,
        resolve(source.cssOutDir ?? this.defaultCssOutDir),
        source.cssBasePath ?? this.defaultCssBasePath
      )
    }
  }

  /** Add CSS entries for a single source, prefixing keys with the namespace. */
  private addCssEntries(
    entry: CssOptions['entry'],
    namespace: string | undefined,
    sourceLabel: string,
    outDir: string,
    basePath: string
  ): void {
    const add = (key: string, src: string, outFile: string) => {
      if (this.cssEntries.has(key)) {
        const prior = this.cssEntries.get(key)!
        throw new Error(
          `[islands] Duplicate CSS key "${key}":\n` +
            `  - ${prior.sourceLabel} (${prior.src})\n` +
            `  - ${sourceLabel} (${src})`
        )
      }
      this.cssEntries.set(key, { key, src, outFile, outDir, basePath, sourceLabel })
    }

    if (typeof entry === 'string') {
      // Single entry: key is namespace itself, or 'default' when no namespace.
      const src = resolve(entry)
      const key = namespace ?? 'default'
      const outFile = namespace ? `${namespace}.css` : basename(src).replace(/\.scss$/, '.css')
      add(key, src, outFile)
    } else if (Array.isArray(entry)) {
      for (const e of entry) {
        const src = resolve(e)
        const filename = basename(src)
        const baseKey = filename.replace(/\.(scss|css)$/, '')
        const key = namespace ? `${namespace}/${baseKey}` : baseKey
        const outFile = namespace
          ? `${namespace}-${baseKey}.css`
          : filename.replace(/\.scss$/, '.css')
        add(key, src, outFile)
      }
    } else {
      for (const [origKey, value] of Object.entries(entry)) {
        const src = resolve(value)
        const key = namespace ? `${namespace}/${origKey}` : origKey
        const outFile = namespace ? `${namespace}-${origKey}.css` : `${origKey}.css`
        add(key, src, outFile)
      }
    }
  }

  /** The content hash of the last build, or null if not yet built. */
  get version(): string | null {
    return this._version
  }

  /** The versioned script src (e.g. '/islands.js?v=abc12345'), or the plain path if not yet built. */
  get src(): string {
    const base = this.basePath + this.outFile
    return this._version ? `${base}?v=${this._version}` : base
  }

  /** The build manifest with file info and sizes, or null if not yet built. */
  get manifest(): IslandManifest | null {
    return this._manifest
  }

  /**
   * The versioned CSS src for the first/default entry (backward compatibility).
   * Returns null if no CSS is configured.
   */
  get cssSrc(): string | null {
    if (this.cssEntries.size === 0) return null

    const entry = this.cssEntries.get('default') || this.cssEntries.values().next().value
    if (!entry) return null

    const base = entry.basePath + entry.outFile
    return entry.version ? `${base}?v=${entry.version}` : base
  }

  /**
   * Get all CSS sources as a Map of key to versioned URL.
   * Returns empty Map if no CSS is configured.
   */
  get cssSrcs(): Map<string, string> {
    const sources = new Map<string, string>()

    for (const entry of this.cssEntries.values()) {
      const base = entry.basePath + entry.outFile
      const url = entry.version ? `${base}?v=${entry.version}` : base
      sources.set(entry.key, url)
    }

    return sources
  }

  /**
   * Get all CSS sources as an array of versioned URLs.
   * Returns empty array if no CSS is configured.
   */
  get cssSrcArray(): string[] {
    return Array.from(this.cssSrcs.values())
  }

  /** Discover all .vue files across every source, with namespaced names. */
  private discoverIslands(): DiscoveredIsland[] {
    const out: DiscoveredIsland[] = []

    for (const source of this.sources) {
      let entries: string[]
      try {
        entries = readdirSync(source.islandsDir, { recursive: true }) as string[]
      } catch {
        continue
      }

      for (const f of entries) {
        if (!f.endsWith('.vue')) continue
        const relName = f.slice(0, -4).replace(/\\/g, '/')
        const fullName = source.namespace ? `${source.namespace}/${relName}` : relName
        out.push({ name: fullName, path: join(source.islandsDir, f), source })
      }
    }

    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

    const seen = new Map<string, ResolvedSource>()
    for (const island of out) {
      const prior = seen.get(island.name)
      if (prior) {
        throw new Error(
          `[islands] Duplicate component "${island.name}":\n` +
            `  - ${prior.label}\n` +
            `  - ${island.source.label}\n` +
            `Add or change a 'namespace' on one of the sources.`
        )
      }
      seen.set(island.name, island.source)
    }

    return out
  }

  /** Find a setup.{ts,js} for each source that has one. */
  private discoverSetupFiles(): DiscoveredSetup[] {
    const setups: DiscoveredSetup[] = []
    for (const source of this.sources) {
      for (const ext of ['ts', 'js']) {
        const p = join(source.islandsDir, `setup.${ext}`)
        if (existsSync(p)) {
          setups.push({ path: p, label: source.label })
          break
        }
      }
    }
    return setups
  }

  /** Generate the virtual entry point that imports all islands + mount logic. */
  private generateEntry(islands: DiscoveredIsland[]): string {
    const setups = this.discoverSetupFiles()
    const lines: string[] = []

    lines.push(`import { createApp, defineComponent, h, Teleport } from 'vue';`)

    // Auto-inject route definitions if router is available
    if (this.router) {
      const routeDefinitions = this.extractRouteDefinitions()
      const routeCount = Object.keys(routeDefinitions).length

      if (routeCount > 0) {
        lines.push(`import { registerRoutes } from '@strav/view/client';`)
        lines.push('')
        lines.push(`// Auto-injected route definitions (${routeCount} routes)`)
        lines.push(`registerRoutes(${JSON.stringify(routeDefinitions, null, 2)});`)
        console.log(
          `[islands] ✅ Auto-injecting ${routeCount} route definitions:`,
          Object.keys(routeDefinitions)
        )
      } else {
        console.log(
          `[islands] ⚠️ Router provided but no named routes found - skipping route auto-injection`
        )
      }
    }

    lines.push('')

    for (let i = 0; i < setups.length; i++) {
      lines.push(`import __setup_${i} from '${setups[i]!.path}';`)
    }
    if (setups.length > 0) {
      lines.push('')
      lines.push(`var __setups = [${setups.map((_, i) => `__setup_${i}`).join(', ')}];`)
      lines.push('')
    }

    // Import each island component
    for (let i = 0; i < islands.length; i++) {
      lines.push(`import __c${i} from '${islands[i]!.path}';`)
    }

    lines.push('')
    lines.push('var components = {')
    for (let i = 0; i < islands.length; i++) {
      lines.push(`  '${islands[i]!.name}': __c${i},`)
    }
    lines.push('};')

    lines.push('')
    // Kebab → PascalCase fallback so <vue:copy-button> resolves CopyButton.
    // Mirrors the standalone client at packages/view/src/client/islands.ts.
    lines.push('function __toPascalCase(s) {')
    lines.push(
      "  return s.replace(/(^|-)(\\w)/g, function(_m, _sep, ch) { return ch.toUpperCase(); });"
    )
    lines.push('}')
    lines.push('')
    lines.push('function mountIslands() {')
    lines.push('  var islands = [];')
    lines.push("  document.querySelectorAll('[data-vue]').forEach(function(el) {")
    lines.push('    var name = el.dataset.vue;')
    lines.push('    if (!name) return;')
    lines.push('    var Component = components[name] || components[__toPascalCase(name)];')
    lines.push('    if (!Component) {')
    lines.push("      console.warn('[islands] Unknown component: ' + name);")
    lines.push('      return;')
    lines.push('    }')
    lines.push("    var props = JSON.parse(el.dataset.props || '{}');")
    lines.push('    islands.push({ Component: Component, props: props, el: el });')
    lines.push('  });')
    lines.push('')
    lines.push('  if (islands.length === 0) return;')
    lines.push('')
    lines.push('  var Root = defineComponent({')
    lines.push('    render: function() {')
    lines.push('      return islands.map(function(island) {')
    lines.push(
      '        return h(Teleport, { to: island.el }, [h(island.Component, island.props)]);'
    )
    lines.push('      });')
    lines.push('    }')
    lines.push('  });')
    lines.push('')
    lines.push('  var app = createApp(Root);')
    if (setups.length > 0) {
      lines.push('  for (var i = 0; i < __setups.length; i++) {')
      lines.push('    if (typeof __setups[i] === "function") __setups[i](app);')
      lines.push('  }')
    }
    lines.push('  var root = document.createElement("div");')
    lines.push('  root.style.display = "contents";')
    lines.push('  document.body.appendChild(root);')
    lines.push('  app.mount(root);')
    lines.push('}')
    lines.push('')
    lines.push("if (document.readyState === 'loading') {")
    lines.push("  document.addEventListener('DOMContentLoaded', mountIslands);")
    lines.push('} else {')
    lines.push('  mountIslands();')
    lines.push('}')

    return lines.join('\n')
  }

  /** Compute a short content hash for cache busting. */
  private computeHash(content: Uint8Array): string {
    const hasher = new Bun.CryptoHasher('md5')
    hasher.update(content)
    return hasher.digest('hex').slice(0, 8)
  }

  /** Generate pre-compressed versions of the bundle. */
  private async generateCompressed(
    outPath: string,
    content: Uint8Array
  ): Promise<{ gzip?: number; brotli?: number }> {
    const sizes: { gzip?: number; brotli?: number } = {}

    // Gzip
    const gzipped = Bun.gzipSync(content as Uint8Array<ArrayBuffer>)
    await Bun.write(outPath + '.gz', gzipped)
    sizes.gzip = gzipped.length

    // Brotli
    try {
      const brotli = brotliCompressSync(Buffer.from(content), {
        params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 },
      })
      await Bun.write(outPath + '.br', brotli)
      sizes.brotli = brotli.length
    } catch {
      // Brotli may not be available in all environments
    }

    return sizes
  }

  /** Remove stale compressed files. */
  private cleanCompressed(outPath: string): void {
    for (const ext of ['.gz', '.br']) {
      try {
        unlinkSync(outPath + ext)
      } catch {
        // File may not exist
      }
    }
  }

  /** Update the ViewEngine global so @islands() and @css() pick up versioned sources. */
  private syncViewEngine(): void {
    try {
      ViewEngine.setGlobal('__islandsSrc', this.src)

      // Set backward-compatible single CSS source
      if (this.cssSrc) {
        ViewEngine.setGlobal('__cssSrc', this.cssSrc)
      }

      // Set multiple CSS sources
      const cssSrcs = this.cssSrcs
      if (cssSrcs.size > 0) {
        const cssSrcObject: Record<string, string> = {}
        for (const [key, url] of cssSrcs.entries()) {
          cssSrcObject[key] = url
        }
        ViewEngine.setGlobal('__cssSrcs', cssSrcObject)
        ViewEngine.setGlobal('__cssSrcArray', this.cssSrcArray)
      }
    } catch {
      // ViewEngine may not be initialized yet
    }
  }

  /** Compile all Sass entries to CSS. */
  async buildCss(): Promise<void> {
    if (this.cssEntries.size === 0) return

    const sass = await import('sass')
    const buildPromises: Promise<void>[] = []

    for (const entry of this.cssEntries.values()) {
      buildPromises.push(this.buildSingleCss(entry, sass))
    }

    await Promise.all(buildPromises)
    this.syncViewEngine()
  }

  /** Compile a single CSS entry. */
  private async buildSingleCss(entry: CssEntry, sass: any): Promise<void> {
    try {
      const result = sass.compile(entry.src, {
        style: this.minify ? 'compressed' : 'expanded',
      })

      mkdirSync(entry.outDir, { recursive: true })
      const outPath = join(entry.outDir, entry.outFile)
      await Bun.write(outPath, result.css)

      const content = new Uint8Array(Buffer.from(result.css))
      entry.version = this.computeHash(content)

      let compressedSizes: { gzip?: number; brotli?: number } = {}
      if (this.compress) {
        compressedSizes = await this.generateCompressed(outPath, content)
      } else {
        this.cleanCompressed(outPath)
      }

      const entryName = basename(entry.src)
      const sizeKB = (content.length / 1024).toFixed(1)
      const gzKB = compressedSizes.gzip
        ? ` | gzip: ${(compressedSizes.gzip / 1024).toFixed(1)}kB`
        : ''
      const brKB = compressedSizes.brotli
        ? ` | br: ${(compressedSizes.brotli / 1024).toFixed(1)}kB`
        : ''

      console.log(
        `[css] Built ${entryName} → ${entry.outFile} (${sizeKB}kB${gzKB}${brKB}) v=${entry.version}`
      )
    } catch (error) {
      console.error(`[css] Failed to build ${entry.src}:`, error)
      throw error
    }
  }

  /** Extract route definitions for client-side registration. */
  private extractRouteDefinitions(): Record<string, { method: string; pattern: string }> {
    if (!this.router) return {}

    const routeMap: Record<string, { method: string; pattern: string }> = {}

    for (const route of this.router.getAllRoutes()) {
      if (route.name) {
        routeMap[route.name] = {
          method: route.method,
          pattern: route.pattern,
        }
      }
    }

    return routeMap
  }

  /**
   * Build the islands bundle with route auto-injection.
   * @param router - Router instance containing routes to inject
   */
  async buildWithRoutes(router: Router): Promise<boolean> {
    this.router = router
    const result = await this.build()
    this.router = null
    return result
  }

  /** Build the islands bundle. Returns true if islands were found and built. */
  async build(): Promise<boolean> {
    const islands = this.discoverIslands()

    if (islands.length === 0) {
      // Still build CSS even if there are no islands
      await this.buildCss()
      return false
    }

    mkdirSync(this.outDir, { recursive: true })

    const entrySource = this.generateEntry(islands)

    // Virtual entry plugin — resolves the synthetic entry from memory
    const virtualEntryPlugin: BunPlugin = {
      name: 'virtual-entry',
      setup(build) {
        build.onResolve({ filter: /^virtual:islands-entry$/ }, () => ({
          path: 'virtual:islands-entry',
          namespace: 'island-entry',
        }))

        build.onLoad({ filter: /.*/, namespace: 'island-entry' }, () => ({
          contents: entrySource,
          loader: 'js',
        }))
      },
    }

    const result = await Bun.build({
      entrypoints: ['virtual:islands-entry'],
      outdir: this.outDir,
      naming: this.outFile,
      format: 'iife',
      minify: this.minify,
      target: 'browser',
      plugins: [virtualEntryPlugin, vueSfcPlugin()],
      define: {
        __VUE_OPTIONS_API__: 'true',
        __VUE_PROD_DEVTOOLS__: 'false',
        __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: 'false',
      },
    })

    if (!result.success) {
      const messages = result.logs.map(l => l.message ?? String(l)).join('\n')
      throw new Error(`Island build failed:\n${messages}`)
    }

    const outPath = join(this.outDir, this.outFile)
    const content = new Uint8Array(await Bun.file(outPath).arrayBuffer())

    this._version = this.computeHash(content)

    let compressedSizes: { gzip?: number; brotli?: number } = {}
    if (this.compress) {
      compressedSizes = await this.generateCompressed(outPath, content)
    } else {
      this.cleanCompressed(outPath)
    }

    this._manifest = {
      file: this.outFile,
      version: this._version,
      src: this.src,
      size: content.length,
      ...compressedSizes,
    }

    await Bun.write(
      join(this.outDir, this.outFile.replace(/\.js$/, '.manifest.json')),
      JSON.stringify(this._manifest, null, 2)
    )

    this.syncViewEngine()

    const sizeKB = (content.length / 1024).toFixed(1)
    const gzKB = compressedSizes.gzip
      ? ` | gzip: ${(compressedSizes.gzip / 1024).toFixed(1)}kB`
      : ''
    const brKB = compressedSizes.brotli
      ? ` | br: ${(compressedSizes.brotli / 1024).toFixed(1)}kB`
      : ''

    console.log(
      `[islands] Built ${islands.length} component(s) → ${this.outFile} (${sizeKB}kB${gzKB}${brKB}) v=${this._version}`
    )

    await this.buildCss()

    return true
  }

  /** Schedule a debounced rebuild of the islands bundle. */
  private scheduleRebuild(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer)
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null
      console.log('[islands] Change detected, rebuilding...')
      this.build().catch(err => console.error('[islands] Rebuild error:', err))
    }, WATCH_DEBOUNCE_MS)
  }

  /** Schedule a debounced CSS rebuild. */
  private scheduleCssRebuild(): void {
    if (this.cssRebuildTimer) clearTimeout(this.cssRebuildTimer)
    this.cssRebuildTimer = setTimeout(() => {
      this.cssRebuildTimer = null
      console.log('[css] Change detected, recompiling...')
      this.buildCss().catch(err => console.error('[css] Build error:', err))
    }, WATCH_DEBOUNCE_MS)
  }

  /** Watch all source directories and rebuild on changes. */
  watch(): void {
    if (this.watchers.size === 0 && !this._version) {
      this.build().catch(err => console.error('[islands] Build error:', err))
    }

    for (const source of this.sources) {
      if (source.packageName && !this.watchPackages) continue
      if (this.watchers.has(source.islandsDir)) continue

      const watcher = fsWatch(source.islandsDir, { recursive: true }, (_event, filename) => {
        if (filename && !filename.endsWith('.vue') && !filename.startsWith('setup.')) return
        this.scheduleRebuild()
      })

      this.watchers.set(source.islandsDir, watcher)
      console.log(`[islands] Watching ${source.label} (${source.islandsDir})`)
    }

    this.watchCss()
  }

  /** Watch CSS source directories for changes. */
  private watchCss(): void {
    if (this.cssEntries.size === 0) return

    const dirsToWatch = new Set<string>()
    for (const entry of this.cssEntries.values()) {
      dirsToWatch.add(dirname(entry.src))
    }

    for (const cssDir of dirsToWatch) {
      if (this.cssWatchers.has(cssDir)) continue

      const watcher = fsWatch(cssDir, { recursive: true }, (_event, filename) => {
        if (filename && !filename.endsWith('.scss') && !filename.endsWith('.css')) return
        this.scheduleCssRebuild()
      })

      this.cssWatchers.set(cssDir, watcher)
      console.log(`[css] Watching ${cssDir}`)
    }
  }

  /** Stop watching. */
  unwatch(): void {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer)
      this.rebuildTimer = null
    }
    if (this.cssRebuildTimer) {
      clearTimeout(this.cssRebuildTimer)
      this.cssRebuildTimer = null
    }

    for (const [dir, watcher] of this.watchers.entries()) {
      watcher.close()
      console.log(`[islands] Stopped watching ${dir}`)
    }
    this.watchers.clear()

    for (const [dir, watcher] of this.cssWatchers.entries()) {
      watcher.close()
      console.log(`[css] Stopped watching ${dir}`)
    }
    this.cssWatchers.clear()
  }
}
