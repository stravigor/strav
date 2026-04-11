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