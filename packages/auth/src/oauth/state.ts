import { randomHex } from '@strav/kernel'

/**
 * OAuth state parameter management for CSRF protection.
 */

export interface OAuthState {
  /** Random state value */
  value: string
  /** Redirect URI after OAuth */
  redirect?: string
  /** Additional data to preserve */
  data?: Record<string, unknown>
  /** Creation timestamp */
  createdAt: number
}

/**
 * Generate a secure OAuth state parameter.
 *
 * @param options - State options
 * @returns State object with secure random value
 */
export function generateOAuthState(options: {
  redirect?: string
  data?: Record<string, unknown>
} = {}): OAuthState {
  return {
    value: randomHex(16),
    redirect: options.redirect,
    data: options.data,
    createdAt: Date.now(),
  }
}

/**
 * Create an OAuth state store with expiration.
 *
 * @param options - Store configuration
 * @returns State store methods
 */
export function createOAuthStateStore(options: {
  /** Store state (e.g., in Redis, database, or memory) */
  store: (state: OAuthState) => Promise<void>
  /** Retrieve state by value */
  retrieve: (value: string) => Promise<OAuthState | null>
  /** Delete state after use */
  delete: (value: string) => Promise<void>
  /** TTL in seconds (default: 600 = 10 minutes) */
  ttl?: number
}) {
  const ttl = options.ttl || 600

  return {
    /**
     * Generate and store a new state.
     */
    async generate(params?: { redirect?: string; data?: Record<string, unknown> }): Promise<string> {
      const state = generateOAuthState(params)
      await options.store(state)
      return state.value
    },

    /**
     * Verify a state parameter and retrieve its data.
     */
    async verify(value: string): Promise<OAuthState | null> {
      const state = await options.retrieve(value)

      if (!state) {
        return null
      }

      // Check expiration
      const age = (Date.now() - state.createdAt) / 1000
      if (age > ttl) {
        await options.delete(value)
        return null
      }

      // Delete after successful verification (one-time use)
      await options.delete(value)
      return state
    },
  }
}

/**
 * Simple in-memory OAuth state store for development.
 * WARNING: Do not use in production - states are lost on restart!
 */
export function createMemoryOAuthStateStore(ttl: number = 600) {
  const states = new Map<string, OAuthState>()

  // Cleanup expired states periodically
  const cleanup = setInterval(() => {
    const now = Date.now()
    for (const [value, state] of states.entries()) {
      if ((now - state.createdAt) / 1000 > ttl) {
        states.delete(value)
      }
    }
  }, 60000) // Every minute

  return createOAuthStateStore({
    async store(state) {
      states.set(state.value, state)
    },
    async retrieve(value) {
      return states.get(value) || null
    },
    async delete(value) {
      states.delete(value)
    },
    ttl,
  })
}