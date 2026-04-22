export { PostgresFtsDriver } from './postgres_fts_driver.ts'
export type {
  PostgresFtsConfig,
  TypoToleranceMode,
  TypoToleranceSettings,
  PgIndexSettings,
} from './types.ts'
export {
  PostgresFtsError,
  MissingExtensionError,
  RebuildRequiredError,
  UnsupportedFilterError,
  MissingConnectionError,
} from './errors.ts'
