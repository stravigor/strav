import type { Context } from '@strav/http'
import Configuration from '@strav/kernel/config/configuration'
import { existsSync } from 'node:fs'
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

    // Resolve the page file path
    const resolution = this.resolvePage(requestPath, viewConfig)

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
  private resolvePage(requestPath: string, viewConfig: ViewConfigWithPages): PageResolutionResult {
    const pagesConfig = viewConfig.pages!
    const baseViewDir = viewConfig.directory || 'resources/views'
    const pagesDir = join(baseViewDir, pagesConfig.directory || 'pages')
    const indexFile = pagesConfig.indexFile || 'index.strav'

    // Normalize the request path
    let normalizedPath = normalize(requestPath).replace(/^\/+/, '')

    // Handle root path
    if (!normalizedPath || normalizedPath === '.') {
      normalizedPath = indexFile
    } else {
      // Handle directory paths (with or without trailing slash)
      if (normalizedPath.endsWith('/')) {
        normalizedPath = join(normalizedPath, indexFile)
      } else {
        // Try as direct file first, then as directory with index
        const directFile = `${normalizedPath}.strav`
        const directFilePath = resolve(pagesDir, directFile)

        if (this.isValidPath(directFilePath, pagesDir) && existsSync(directFilePath)) {
          normalizedPath = directFile
        } else {
          normalizedPath = join(normalizedPath, indexFile)
        }
      }
    }

    const filePath = resolve(pagesDir, normalizedPath)

    return {
      filePath,
      exists: existsSync(filePath),
      isValid: this.isValidPath(filePath, pagesDir) && normalizedPath.endsWith('.strav')
    }
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