/** Engine-wide configuration for `@strav/durable`. */
export interface DurableConfig {
  /**
   * The `@strav/queue` queue name durable jobs are dispatched on. Run a
   * `Worker({ queue })` on this name to process durable workflows. Keeping
   * it separate from app jobs lets durable work be scaled independently.
   */
  queue: string
  /**
   * Per-job timeout (ms) for `durable:advance` / `durable:compensate` jobs.
   * Must comfortably exceed the slowest single step (e.g. an LLM call).
   */
  jobTimeout: number
  /**
   * Queue-level max attempts for durable jobs. This insures against *process
   * crashes* only — application-level step retries are handled by the engine
   * via the journal `attempt` count, independently of this.
   */
  maxAttempts: number
}

const config: DurableConfig = {
  queue: 'durable',
  jobTimeout: 600_000,
  maxAttempts: 5,
}

/** Read the current durable engine configuration. */
export function getConfig(): DurableConfig {
  return config
}

/** Override durable engine configuration. Call before booting workers. */
export function configureDurable(patch: Partial<DurableConfig>): void {
  Object.assign(config, patch)
}
