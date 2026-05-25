import { inject, ConfigurationError, Configuration } from '@strav/kernel'
import { AnthropicProvider } from './providers/anthropic_provider.ts'
import { OpenAIProvider } from './providers/openai_provider.ts'
import type {
  AIProvider,
  BrainConfig,
  ProviderConfig,
  CompletionRequest,
  CompletionResponse,
  BeforeHook,
  AfterHook,
  TranscribeRequest,
  TranscriptionResponse,
} from './types.ts'
import type { MemoryConfig, ThreadStore } from './memory/types.ts'

/**
 * Central AI configuration hub.
 *
 * Resolved once via the DI container — reads the AI config
 * and initializes the appropriate provider drivers.
 *
 * @example
 * app.singleton(BrainManager)
 * app.resolve(BrainManager)
 *
 * // Plug in a custom provider
 * BrainManager.useProvider(new OllamaProvider())
 */
@inject
export default class BrainManager {
  private static _config: BrainConfig
  private static _providers = new Map<string, AIProvider>()
  private static _beforeHooks: BeforeHook[] = []
  private static _afterHooks: AfterHook[] = []
  private static _threadStore: ThreadStore | null = null
  private static _memoryConfig: MemoryConfig = {}

  constructor(config: Configuration) {
    BrainManager._config = {
      default: config.get('ai.default', 'anthropic') as string,
      providers: config.get('ai.providers', {}) as Record<string, ProviderConfig>,
      maxTokens: config.get('ai.maxTokens', 4096) as number,
      temperature: config.get('ai.temperature', 0.7) as number,
      maxIterations: config.get('ai.maxIterations', 10) as number,
    }

    BrainManager._memoryConfig = config.get('ai.memory', {}) as MemoryConfig

    for (const [name, providerConfig] of Object.entries(BrainManager._config.providers)) {
      BrainManager._providers.set(name, BrainManager.createProvider(name, providerConfig))
    }
  }

  private static createProvider(name: string, config: ProviderConfig): AIProvider {
    const driver = config.driver ?? name
    switch (driver) {
      case 'anthropic':
        return new AnthropicProvider(config)
      case 'openai':
        return new OpenAIProvider(config, name)
      default:
        throw new ConfigurationError(
          `Unknown AI provider driver: ${driver}. Use BrainManager.useProvider() for custom providers.`
        )
    }
  }

  static get config(): BrainConfig {
    if (!BrainManager._config) {
      throw new ConfigurationError(
        'BrainManager not configured. Resolve it through the container first.'
      )
    }
    return BrainManager._config
  }

  /** Get a provider by name, or the default provider. */
  static provider(name?: string): AIProvider {
    const key = name ?? BrainManager._config.default
    const p = BrainManager._providers.get(key)
    if (!p) throw new ConfigurationError(`AI provider "${key}" not configured.`)
    return p
  }

  /** Swap or add a provider at runtime (e.g., for testing or a custom provider). */
  static useProvider(provider: AIProvider): void {
    BrainManager._providers.set(provider.name, provider)
  }

  /** Get the configured memory settings. */
  static get memoryConfig(): MemoryConfig {
    return BrainManager._memoryConfig
  }

  /** Get the registered thread store, if any. */
  static get threadStore(): ThreadStore | null {
    return BrainManager._threadStore
  }

  /** Register a thread store for persistence (e.g., DatabaseThreadStore). */
  static useThreadStore(store: ThreadStore): void {
    BrainManager._threadStore = store
  }

  /** Register a hook that runs before every completion. */
  static before(hook: BeforeHook): void {
    BrainManager._beforeHooks.push(hook)
  }

  /** Register a hook that runs after every completion. */
  static after(hook: AfterHook): void {
    BrainManager._afterHooks.push(hook)
  }

  /**
   * Run a completion through the named provider, with before/after hooks.
   * Used internally by AgentRunner and the `brain` helper.
   */
  static async complete(
    providerName: string | undefined,
    request: CompletionRequest
  ): Promise<CompletionResponse> {
    for (const hook of BrainManager._beforeHooks) await hook(request)
    const response = await BrainManager.provider(providerName).complete(request)
    for (const hook of BrainManager._afterHooks) await hook(request, response)
    return response
  }

  /**
   * Transcribe audio through the named provider. Throws a clear
   * ConfigurationError if the provider doesn't implement `transcribe()`
   * (Anthropic, at time of writing). Hooks are not invoked — they're
   * shaped for chat completions and don't carry an audio analogue.
   */
  static async transcribe(
    providerName: string | undefined,
    request: TranscribeRequest
  ): Promise<TranscriptionResponse> {
    const provider = BrainManager.provider(providerName)
    if (!provider.transcribe) {
      throw new ConfigurationError(
        `AI provider "${provider.name}" does not support transcribe(). ` +
          `Use the OpenAI or Google providers, or register a custom one via BrainManager.useProvider().`
      )
    }
    return provider.transcribe(request)
  }

  /** Clear all providers, hooks, and stores (for testing). */
  static reset(): void {
    BrainManager._providers.clear()
    BrainManager._beforeHooks = []
    BrainManager._afterHooks = []
    BrainManager._threadStore = null
    BrainManager._memoryConfig = {}
  }
}
