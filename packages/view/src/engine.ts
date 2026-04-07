import { resolve, join } from 'node:path'
import { watch as fsWatch, type FSWatcher } from 'node:fs'
import { inject } from '@strav/kernel/core/inject'
import Configuration from '@strav/kernel/config/configuration'
import { escapeHtml } from './escape.ts'
import { tokenize } from './tokenizer.ts'
import { compile } from './compiler.ts'
import TemplateCache from './cache.ts'
import type { CacheEntry, RenderFunction, IncludeFn } from './cache.ts'
import { ConfigurationError, TemplateError } from '@strav/kernel/exceptions/errors'

const MAX_INCLUDE_DEPTH = 50

@inject
export default class ViewEngine {
  private static _instance: ViewEngine | null = null
  private static _globals: Record<string, unknown> = {}

  private directory: string
  private cacheEnabled: boolean
  private cache: TemplateCache
  private watcher: FSWatcher | null = null

  constructor(config: Configuration) {
    this.directory = resolve(config.get('view.directory', 'resources/views') as string)
    this.cacheEnabled = config.get('view.cache', true) as boolean
    this.cache = new TemplateCache()
    ViewEngine._instance = this
  }

  static get instance(): ViewEngine {
    if (!ViewEngine._instance) {
      throw new ConfigurationError('ViewEngine not configured. Register it in the container.')
    }
    return ViewEngine._instance
  }

  /** Register a global variable available in all templates. */
  static setGlobal(key: string, value: unknown): void {
    ViewEngine._globals[key] = value
  }

  async render(name: string, data: Record<string, unknown> = {}): Promise<string> {
    const merged = { ...ViewEngine._globals, ...data }
    return this.renderWithDepth(name, merged, 0)
  }

  private async renderWithDepth(
    name: string,
    data: Record<string, unknown>,
    depth: number,
    parentStacks: Record<string, string[]> = {}
  ): Promise<string> {
    if (depth > MAX_INCLUDE_DEPTH) {
      throw new TemplateError(
        `Maximum include depth (${MAX_INCLUDE_DEPTH}) exceeded — possible circular include`
      )
    }

    const entry = await this.resolve(name)

    // Create an include function that merges stacks from includes
    const includeFn: IncludeFn = async (includeName, includeData) => {
      const includeResult = await this.renderWithDepthInternal(
        includeName,
        { ...data, ...includeData },
        depth + 1,
        {}
      )
      // Merge include's stacks into parent stacks
      this.mergeStacks(parentStacks, includeResult.stacks)
      return includeResult.output
    }

    // Pass parent stacks to the template
    const dataWithStacks = { ...data, __stacks: { ...parentStacks } }
    const result = await entry.fn(dataWithStacks, includeFn)

    // Merge current template's stacks with parent stacks
    this.mergeStacks(parentStacks, result.stacks)

    // Layout inheritance: render child first, then render layout with blocks and stacks merged
    if (entry.layout) {
      const layoutData = { ...data, ...result.blocks, __stacks: parentStacks }
      return this.renderWithDepth(entry.layout, layoutData, depth + 1, parentStacks)
    }

    return result.output
  }

  private async renderWithDepthInternal(
    name: string,
    data: Record<string, unknown>,
    depth: number,
    parentStacks: Record<string, string[]> = {}
  ): Promise<{ output: string; stacks: Record<string, string[]> }> {
    if (depth > MAX_INCLUDE_DEPTH) {
      throw new TemplateError(
        `Maximum include depth (${MAX_INCLUDE_DEPTH}) exceeded — possible circular include`
      )
    }

    const entry = await this.resolve(name)

    const includeFn: IncludeFn = async (includeName, includeData) => {
      const includeResult = await this.renderWithDepthInternal(
        includeName,
        { ...data, ...includeData },
        depth + 1,
        {}
      )
      this.mergeStacks(parentStacks, includeResult.stacks)
      return includeResult.output
    }

    const dataWithStacks = { ...data, __stacks: { ...parentStacks } }
    const result = await entry.fn(dataWithStacks, includeFn)
    this.mergeStacks(parentStacks, result.stacks)

    if (entry.layout) {
      const layoutData = { ...data, ...result.blocks, __stacks: parentStacks }
      const layoutOutput = await this.renderWithDepth(entry.layout, layoutData, depth + 1, parentStacks)
      return { output: layoutOutput, stacks: parentStacks }
    }

    return { output: result.output, stacks: parentStacks }
  }

  private mergeStacks(target: Record<string, string[]>, source: Record<string, string[]>): void {
    for (const [key, values] of Object.entries(source)) {
      if (!target[key]) {
        target[key] = []
      }
      target[key].push(...values)
    }
  }

  private async resolve(name: string): Promise<CacheEntry> {
    const cached = this.cache.get(name)

    if (cached) {
      if (this.cacheEnabled) return cached
      const stale = await this.cache.isStale(name)
      if (!stale) return cached
    }

    return this.compileTemplate(name)
  }

  private async compileTemplate(name: string): Promise<CacheEntry> {
    const filePath = this.resolvePath(name)
    const file = Bun.file(filePath)

    const exists = await file.exists()
    if (!exists) {
      throw new TemplateError(`Template not found: ${name} (looked at ${filePath})`)
    }

    const source = await file.text()
    const tokens = tokenize(source)
    const result = compile(tokens)
    const fn = this.createRenderFunction(result.code)

    const entry: CacheEntry = {
      fn,
      layout: result.layout,
      mtime: file.lastModified,
      filePath,
    }

    this.cache.set(name, entry)
    return entry
  }

  /** Watch the views directory for `.strav` changes and clear the cache. */
  watch(): void {
    if (this.watcher) return

    this.watcher = fsWatch(this.directory, { recursive: true }, (_event, filename) => {
      if (!filename || !filename.endsWith('.strav')) return
      this.cache.clear()
      console.log(`[views] ${filename} changed, cache cleared`)
    })

    console.log(`[views] Watching ${this.directory}`)
  }

  /** Stop watching for template changes. */
  unwatch(): void {
    if (this.watcher) {
      this.watcher.close()
      this.watcher = null
    }
  }

  private resolvePath(name: string): string {
    const relativePath = name.replace(/\./g, '/') + '.strav'
    return join(this.directory, relativePath)
  }

  private createRenderFunction(code: string): RenderFunction {
    // Use async Function with `with` statement for scope injection.
    // `new Function()` does not inherit strict mode, so `with` is available.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor

    const fn = new AsyncFunction('__data', '__escape', '__include', `with (__data) {\n${code}\n}`)

    return (data: Record<string, unknown>, includeFn: IncludeFn) => {
      return fn(data, escapeHtml, includeFn)
    }
  }
}

export async function view(
  name: string,
  data: Record<string, unknown> = {},
  status = 200
): Promise<Response> {
  const html = await ViewEngine.instance.render(name, data)
  return new Response(html, {
    status,
    headers: { 'Content-Type': 'text/html' },
  })
}
