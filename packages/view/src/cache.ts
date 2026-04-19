export interface RenderResult {
  output: string
  blocks: Record<string, string>
  stacks: Record<string, string[]>
  variables: Record<string, unknown>
}

export type RenderFunction = (
  data: Record<string, unknown>,
  includeFn: IncludeFn
) => Promise<RenderResult>

export type IncludeFn = (name: string, data: Record<string, unknown>) => Promise<string>

export interface CacheEntry {
  fn: RenderFunction
  layout?: string
  mtime: number
  filePath: string
}

export default class TemplateCache {
  private entries = new Map<string, CacheEntry>()

  get(name: string): CacheEntry | undefined {
    return this.entries.get(name)
  }

  set(name: string, entry: CacheEntry): void {
    this.entries.set(name, entry)
  }

  async isStale(name: string): Promise<boolean> {
    const entry = this.entries.get(name)
    if (!entry) return true
    const file = Bun.file(entry.filePath)
    const exists = await file.exists()
    if (!exists) return true
    return file.lastModified > entry.mtime
  }

  delete(name: string): void {
    this.entries.delete(name)
  }

  clear(): void {
    this.entries.clear()
  }
}
