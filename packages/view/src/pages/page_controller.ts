import type { Context } from '@strav/http'
import Configuration from '@strav/kernel/config/configuration'
import { existsSync, readdirSync } from 'node:fs'
import { join, normalize, resolve } from 'node:path'
import type { PageResolutionResult, ViewConfigWithPages } from './types.ts'
import { inject } from '@strav/kernel'

/**
 * Controller that handles catch-all routes for static pages
 */
@inject
export default class PageController {
  constructor(private config: Configuration) {}
  /**
   * Handle static page requests by mapping URLs to .strav files
   */
  async handle(ctx: Context): Promise<Response> {
    const viewConfig = this.config.get('view', {}) as ViewConfigWithPages
    const pagesConfig = viewConfig.pages

    // Return 404 if pages are disabled or not configured
    if (!pagesConfig?.enabled) {
      return new Response('Not Found', { status: 404 })
    }

    // Get the requested path from route parameters
    const requestPath = ctx.params.path || ''

    // Get subdomain if subdomain routing is enabled
    const subdomain = pagesConfig.subdomains?.enabled ? ctx.subdomain : ''

    // Resolve the page file path
    const resolution = this.resolvePage(requestPath, viewConfig, subdomain)

    // Return 404 if path is invalid or file doesn't exist
    if (!resolution.isValid || !resolution.exists) {
      return new Response('Not Found', { status: 404 })
    }

    try {
      // Render the template using the view engine
      return await ctx.view(this.getTemplatePath(resolution.filePath, viewConfig))
    } catch (error) {
      // Return 500 for template rendering errors
      console.error('Error rendering page template:', error)
      return new Response('Internal Server Error', { status: 500 })
    }
  }

  /**
   * Resolve a request path to a .strav file
   */
  private resolvePage(requestPath: string, viewConfig: ViewConfigWithPages, subdomain: string = ''): PageResolutionResult {
    const pagesConfig = viewConfig.pages!
    const baseViewDir = viewConfig.directory || 'resources/views'
    const basePagesDir = join(baseViewDir, pagesConfig.directory || 'pages')
    const indexFile = pagesConfig.indexFile || 'index.strav'

    // Determine the pages directory based on subdomain
    let pagesDir = basePagesDir
    if (subdomain && pagesConfig.subdomains?.enabled) {
      const subdomainDir = this.getSubdomainDirectory(subdomain, pagesConfig)
      if (subdomainDir) {
        pagesDir = join(basePagesDir, subdomainDir)
      }
    } else if (!subdomain && pagesConfig.subdomains?.enabled && pagesConfig.subdomains.defaultDirectory) {
      // Use default directory for main domain when subdomains are enabled
      pagesDir = join(basePagesDir, pagesConfig.subdomains.defaultDirectory)
    }

    // Normalize the request path
    const normalizedPath = normalize(requestPath).replace(/^\/+/, '')

    // Root and trailing-slash requests must resolve to a directory index,
    // never to a sibling `<segment>.strav` file.
    const requireIndex =
      !normalizedPath || normalizedPath === '.' || normalizedPath.endsWith('/')

    // URL path segments, with empties and '.' stripped.
    const segments = normalizedPath
      .replace(/\/+$/, '')
      .split('/')
      .filter((s) => s && s !== '.')

    // Group folders are on by default; disable restores legacy resolution.
    const groupsEnabled = pagesConfig.groupFolders !== false

    let resolved = this.findPage(pagesDir, segments, indexFile, basePagesDir, requireIndex, groupsEnabled)

    // Try fallback to default directory if enabled and page not found
    if (
      !resolved &&
      subdomain &&
      pagesConfig.subdomains?.fallbackToDefault !== false &&
      pagesConfig.subdomains?.defaultDirectory
    ) {
      const defaultDir = join(basePagesDir, pagesConfig.subdomains.defaultDirectory)
      resolved = this.findPage(defaultDir, segments, indexFile, basePagesDir, requireIndex, groupsEnabled)
    }

    if (resolved) {
      return { filePath: resolved, exists: true, isValid: true }
    }

    // Best-effort path for the (404) result; handler only checks exists/isValid.
    const missPath = resolve(pagesDir, (segments.join('/') || indexFile) + (requireIndex ? `/${indexFile}` : '.strav'))
    return { filePath: missPath, exists: false, isValid: false }
  }

  /**
   * Recursively resolve URL segments to a `.strav` file, treating any
   * directory matching `(group)` as transparent (consumes no URL segment).
   * Direct (non-group) matches are attempted before descending into group
   * folders, so direct always wins; groups are tried in alphabetical order.
   * Returns the absolute file path, or null if nothing matches.
   */
  private findPage(
    searchDir: string,
    segments: string[],
    indexFile: string,
    basePagesDir: string,
    requireIndex: boolean,
    groupsEnabled: boolean
  ): string | null {
    if (segments.length === 0) {
      const indexPath = resolve(searchDir, indexFile)
      if (this.isValidPath(indexPath, basePagesDir) && existsSync(indexPath)) {
        return indexPath
      }
    } else {
      // `head` always defined here (segments is non-empty in this branch);
      // the default only satisfies noUncheckedIndexedAccess.
      const [head = '', ...rest] = segments

      // Leaf segment may map directly to `<head>.strav` (unless an index
      // was explicitly requested via a trailing slash).
      if (rest.length === 0 && !requireIndex) {
        const filePath = resolve(searchDir, `${head}.strav`)
        if (this.isValidPath(filePath, basePagesDir) && existsSync(filePath)) {
          return filePath
        }
      }

      // Descend into a real subdirectory named after the segment.
      const subDir = resolve(searchDir, head)
      if (this.isValidPath(subDir, basePagesDir) && existsSync(subDir)) {
        const found = this.findPage(subDir, rest, indexFile, basePagesDir, requireIndex, groupsEnabled)
        if (found) return found
      }
    }

    // Only after direct resolution fails: descend into transparent group
    // folders, keeping the same segments (a group consumes no URL part).
    if (groupsEnabled) {
      for (const group of this.listGroupDirs(searchDir)) {
        const found = this.findPage(
          resolve(searchDir, group),
          segments,
          indexFile,
          basePagesDir,
          requireIndex,
          groupsEnabled
        )
        if (found) return found
      }
    }

    return null
  }

  /**
   * List immediate subdirectories whose name matches `(group)`, sorted
   * alphabetically for deterministic resolution. Missing/unreadable
   * directories yield an empty list.
   */
  private listGroupDirs(dir: string): string[] {
    try {
      return readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^\(.+\)$/.test(entry.name))
        .map((entry) => entry.name)
        .sort()
    } catch {
      return []
    }
  }

  /**
   * Get the subdomain-specific directory based on mappings
   */
  private getSubdomainDirectory(subdomain: string, pagesConfig: ViewConfigWithPages['pages']): string | null {
    if (!pagesConfig?.subdomains?.mappings) return null

    // First check for exact match
    if (pagesConfig.subdomains.mappings[subdomain]) {
      return pagesConfig.subdomains.mappings[subdomain]
    }

    // Check for dynamic patterns (e.g., :tenant)
    for (const [pattern, directory] of Object.entries(pagesConfig.subdomains.mappings)) {
      if (pattern.startsWith(':')) {
        // Dynamic pattern matches any subdomain
        return directory
      }
    }

    return null
  }

  /**
   * Check if a file path is valid and secure (no path traversal)
   */
  private isValidPath(filePath: string, baseDir: string): boolean {
    const resolvedBase = resolve(baseDir)
    const resolvedFile = resolve(filePath)

    // Ensure the resolved file path is within the base directory
    return resolvedFile.startsWith(resolvedBase + '/') || resolvedFile === resolvedBase
  }

  /**
   * Convert absolute file path to template path relative to view directory
   */
  private getTemplatePath(filePath: string, viewConfig: ViewConfigWithPages): string {
    const baseViewDir = resolve(viewConfig.directory || 'resources/views')
    const relativePath = filePath.replace(baseViewDir + '/', '')

    // Remove .strav extension for template rendering
    return relativePath.replace(/\.strav$/, '')
  }
}