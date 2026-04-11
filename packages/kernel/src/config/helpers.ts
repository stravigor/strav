import { app } from '../core/application.ts'
import Configuration from './configuration.ts'

let cachedConfig: Configuration | undefined

function getConfig(): Configuration {
  if (!cachedConfig) {
    cachedConfig = app.resolve(Configuration)
  }
  return cachedConfig
}

/**
 * Read a configuration value using dot notation.
 *
 * @example
 * config('database.host', 'localhost')
 * config('app.name')
 * config('cache.default', 'memory')
 */
function config(key: string, defaultValue?: any): any {
  return getConfig().get(key, defaultValue)
}

/** Read a configuration value as an integer. */
config.int = (key: string, defaultValue?: number): number => {
  const value = getConfig().get(key, defaultValue)
  if (value === undefined || value === null) {
    if (defaultValue !== undefined) return defaultValue
    throw new Error(`Configuration value "${key}" is not set`)
  }
  const parsed = parseInt(String(value), 10)
  if (isNaN(parsed)) {
    if (defaultValue !== undefined) return defaultValue
    throw new Error(`Configuration value "${key}" is not a valid integer`)
  }
  return parsed
}

/** Read a configuration value as a float. */
config.float = (key: string, defaultValue?: number): number => {
  const value = getConfig().get(key, defaultValue)
  if (value === undefined || value === null) {
    if (defaultValue !== undefined) return defaultValue
    throw new Error(`Configuration value "${key}" is not set`)
  }
  const parsed = parseFloat(String(value))
  if (isNaN(parsed)) {
    if (defaultValue !== undefined) return defaultValue
    throw new Error(`Configuration value "${key}" is not a valid number`)
  }
  return parsed
}

/** Read a configuration value as a boolean. Truthy: true, 'true', '1', 'yes'. */
config.bool = (key: string, defaultValue?: boolean): boolean => {
  const value = getConfig().get(key, defaultValue)
  if (value === undefined || value === null) {
    if (defaultValue !== undefined) return defaultValue
    throw new Error(`Configuration value "${key}" is not set`)
  }
  if (typeof value === 'boolean') return value
  const strValue = String(value).toLowerCase()
  return strValue === 'true' || strValue === '1' || strValue === 'yes'
}

/** Read a configuration value as an array. */
config.array = <T = any>(key: string, defaultValue?: T[]): T[] => {
  const value = getConfig().get(key, defaultValue)
  if (value === undefined || value === null) {
    if (defaultValue !== undefined) return defaultValue
    return []
  }
  if (Array.isArray(value)) return value
  if (defaultValue !== undefined) return defaultValue
  return []
}

/** Check whether a configuration key exists. */
config.has = (key: string): boolean => {
  return getConfig().has(key)
}

/** Set a configuration value at runtime. */
config.set = (key: string, value: any): void => {
  getConfig().set(key, value)
}

/** Get all configuration data. */
config.all = (): Record<string, any> => {
  return getConfig().all()
}

export { config }