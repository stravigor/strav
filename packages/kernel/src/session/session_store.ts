/**
 * Persisted shape of a session. Stores map this to their native representation
 * (row, Redis value, etc.) and reconstruct it on read.
 */
export interface SessionRecord {
  id: string
  userId: string | null
  csrfToken: string
  data: Record<string, unknown>
  ipAddress: string | null
  userAgent: string | null
  lastActivity: Date
  createdAt: Date
}

/**
 * Pluggable session storage backend.
 *
 * Implement this interface to back sessions with Postgres, Redis, or any other store.
 * `@strav/database` ships PostgresSessionStore and RedisSessionStore out of the box;
 * `@strav/http` orchestrates them via SessionManager.
 */
export interface SessionStore {
  /** One-time setup (create SQL table, etc.). No-op for TTL-based stores like Redis. */
  ensureSchema?(): Promise<void>

  /** Look up a session by ID. Returns null if not found. */
  find(id: string): Promise<SessionRecord | null>

  /** Persist a session record (insert or update). */
  save(record: SessionRecord): Promise<void>

  /** Delete a session by ID. */
  destroy(id: string): Promise<void>

  /** Refresh the session's last-activity timestamp. */
  touch(id: string): Promise<void>

  /**
   * Delete sessions whose last activity is older than the cutoff.
   * Returns the number of sessions removed. No-op for stores with native TTL.
   */
  gc(cutoff: Date): Promise<number>
}
