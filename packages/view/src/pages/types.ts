/**
 * Configuration for static pages feature
 */
export interface PagesConfig {
  /**
   * Directory containing page files, relative to the view directory
   * @default 'pages'
   */
  directory: string

  /**
   * Whether pages serving is enabled
   * @default true
   */
  enabled?: boolean

  /**
   * Default file to serve for directory requests
   * @default 'index.strav'
   */
  indexFile?: string

  /**
   * Subdomain routing configuration
   */
  subdomains?: SubdomainConfig
}

/**
 * Configuration for subdomain routing
 */
export interface SubdomainConfig {
  /**
   * Whether subdomain routing is enabled
   * @default false
   */
  enabled?: boolean

  /**
   * Map of subdomain patterns to directories
   * Keys can be static (e.g., 'docs') or dynamic (e.g., ':tenant')
   * Values are directory names within the pages directory
   * @example
   * {
   *   'docs': '_docs',      // docs.example.com → pages/_docs/
   *   'api': '_api',        // api.example.com → pages/_api/
   *   ':tenant': '_tenants' // *.example.com → pages/_tenants/
   * }
   */
  mappings?: Record<string, string>

  /**
   * Default directory for pages without subdomain (main domain)
   * @default '_default'
   */
  defaultDirectory?: string

  /**
   * Whether to fallback to default directory when subdomain page not found
   * @default true
   */
  fallbackToDefault?: boolean
}

/**
 * Result of page path resolution
 */
export interface PageResolutionResult {
  /**
   * Absolute path to the resolved .strav file
   */
  filePath: string

  /**
   * Whether the file exists on disk
   */
  exists: boolean

  /**
   * Whether the path is valid and secure (no path traversal)
   */
  isValid: boolean
}

/**
 * Extended view configuration that includes pages
 */
export interface ViewConfigWithPages {
  directory: string
  cache?: boolean
  assets?: string[]
  pages?: PagesConfig
}