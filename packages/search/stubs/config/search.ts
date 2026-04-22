import { env } from '@strav/kernel'

export default {
  /** The default search driver to use. */
  default: env('SEARCH_DRIVER', 'meilisearch'),

  /** Index name prefix (useful for multi-tenant or multi-environment). */
  prefix: env('SEARCH_PREFIX', ''),

  drivers: {
    meilisearch: {
      driver: 'meilisearch',
      host: env('MEILISEARCH_HOST', 'localhost'),
      port: env('MEILISEARCH_PORT', '7700').int(),
      apiKey: env('MEILISEARCH_KEY', ''),
    },

    typesense: {
      driver: 'typesense',
      host: env('TYPESENSE_HOST', 'localhost'),
      port: env('TYPESENSE_PORT', '8108').int(),
      apiKey: env('TYPESENSE_KEY', ''),
      protocol: 'http',
    },

    algolia: {
      driver: 'algolia',
      appId: env('ALGOLIA_APP_ID', ''),
      apiKey: env('ALGOLIA_SECRET', ''),
    },

    embedded: {
      driver: 'embedded',
      /** Directory holding per-index `.sqlite` files. Use ':memory:' for tests. */
      path: env('SEARCH_PATH', './storage/search'),
      /** SQLite synchronous pragma. NORMAL is crash-safe with sub-second-of-writes loss. */
      synchronous: env('SEARCH_SYNCHRONOUS', 'NORMAL'),
      /** Typo tolerance: 'off' to disable, 'auto' for defaults, or { minTokenLength, maxDistance }. */
      typoTolerance: env('SEARCH_TYPO_TOLERANCE', 'auto'),
    },
  },
}
