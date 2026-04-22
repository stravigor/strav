import type Context from '../http/context.ts'
import { clearCookie } from '../http/cookie.ts'
import { randomHex } from '@strav/kernel/helpers/crypto'
import type { SessionRecord } from '@strav/kernel/session/session_store'
import { extractUserId } from '@strav/database/helpers/identity'
import SessionManager from './session_manager.ts'

const FLASH_KEY = '_flash'
const FLASH_OLD_KEY = '_flash_old'

/**
 * Unified server-side session backed by a {@link SessionStore} and an
 * HTTP-only cookie.
 *
 * Serves both anonymous visitors and authenticated users. Stores arbitrary
 * key-value data and supports flash data (available only on the next request).
 *
 * @example
 * // Read / write data (anonymous or authenticated)
 * const session = ctx.get<Session>('session')
 * session.set('cart', [item])
 * session.flash('success', 'Item added!')
 *
 * // Login
 * session.authenticate(user)
 * await session.regenerate()
 *
 * // Logout
 * return Session.destroy(ctx, ctx.redirect('/login'))
 */
export default class Session {
  private _id: string
  private _userId: string | null
  private _csrfToken: string
  private _data: Record<string, unknown>
  private _dirty = false

  constructor(
    id: string,
    userId: string | null,
    csrfToken: string,
    data: Record<string, unknown>,
    readonly ipAddress: string | null,
    readonly userAgent: string | null,
    readonly lastActivity: Date,
    readonly createdAt: Date
  ) {
    this._id = id
    this._userId = userId
    this._csrfToken = csrfToken
    this._data = data
  }

  // ---------------------------------------------------------------------------
  // Getters
  // ---------------------------------------------------------------------------

  get id(): string {
    return this._id
  }

  get userId(): string | null {
    return this._userId
  }

  get csrfToken(): string {
    return this._csrfToken
  }

  get isAuthenticated(): boolean {
    return this._userId !== null
  }

  get isDirty(): boolean {
    return this._dirty
  }

  // ---------------------------------------------------------------------------
  // Data bag
  // ---------------------------------------------------------------------------

  /** Get a value from the session data. */
  get<T = unknown>(key: string, defaultValue?: T): T {
    return (this._data[key] as T) ?? (defaultValue as T)
  }

  /** Set a persistent session value. */
  set(key: string, value: unknown): void {
    this._data[key] = value
    this._dirty = true
  }

  /** Check whether a key exists in the session data. */
  has(key: string): boolean {
    return key in this._data && !key.startsWith('_flash')
  }

  /** Remove a key from the session data. */
  forget(key: string): void {
    delete this._data[key]
    this._dirty = true
  }

  /** Remove all session data (keeps the session row alive). */
  flush(): void {
    this._data = {}
    this._dirty = true
  }

  /** Return all user-facing session data (excludes flash internals). */
  all(): Record<string, unknown> {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(this._data)) {
      if (!key.startsWith('_flash')) {
        result[key] = value
      }
    }
    return result
  }

  // ---------------------------------------------------------------------------
  // Flash data
  // ---------------------------------------------------------------------------

  /** Set flash data that will be available only on the next request. */
  flash(key: string, value: unknown): void {
    const bag = (this._data[FLASH_KEY] ?? {}) as Record<string, unknown>
    bag[key] = value
    this._data[FLASH_KEY] = bag
    this._dirty = true
  }

  /** Get flash data set by the previous request. */
  getFlash<T = unknown>(key: string): T | undefined {
    const old = this._data[FLASH_OLD_KEY] as Record<string, unknown> | undefined
    return old?.[key] as T | undefined
  }

  /** Check if there is flash data for the given key (from previous request). */
  hasFlash(key: string): boolean {
    const old = this._data[FLASH_OLD_KEY] as Record<string, unknown> | undefined
    return old !== undefined && key in old
  }

  /**
   * Rotate flash data for the next request cycle. Called once per request
   * by the session middleware before the handler runs.
   *
   * Moves `_flash` → `_flash_old` (readable this request), then clears `_flash`.
   * Only marks dirty if there was actually flash data to rotate.
   */
  ageFlash(): void {
    const current = this._data[FLASH_KEY]
    const old = this._data[FLASH_OLD_KEY]

    if (current !== undefined || old !== undefined) {
      this._data[FLASH_OLD_KEY] = current ?? {}
      delete this._data[FLASH_KEY]
      this._dirty = true
    }
  }

  // ---------------------------------------------------------------------------
  // Authentication
  // ---------------------------------------------------------------------------

  /** Associate this session with a user (login). */
  authenticate(user: unknown): void {
    this._userId = extractUserId(user)
    this._dirty = true
  }

  /** Disassociate the user from this session. */
  clearUser(): void {
    this._userId = null
    this._dirty = true
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Whether this session has exceeded its configured lifetime. */
  isExpired(): boolean {
    const lifetimeMs = SessionManager.config.lifetime * 60_000
    return Date.now() - this.lastActivity.getTime() > lifetimeMs
  }

  /** Update the last_activity timestamp to keep the session alive. */
  async touch(): Promise<void> {
    await SessionManager.store.touch(this._id)
  }

  /**
   * Regenerate the session ID and CSRF token. Use after login to
   * prevent session fixation attacks.
   */
  async regenerate(): Promise<void> {
    const oldId = this._id
    this._id = crypto.randomUUID()
    this._csrfToken = randomHex(32)
    this._dirty = true

    await this.save()
    await SessionManager.store.destroy(oldId)
  }

  /**
   * Persist session data via the configured {@link SessionStore}. No-op if the
   * session has not been modified.
   */
  async save(): Promise<void> {
    if (!this._dirty) return

    const dataToSave = { ...this._data }
    delete dataToSave[FLASH_OLD_KEY]

    await SessionManager.store.save({
      id: this._id,
      userId: this._userId,
      csrfToken: this._csrfToken,
      data: dataToSave,
      ipAddress: this.ipAddress,
      userAgent: this.userAgent,
      lastActivity: new Date(),
      createdAt: this.createdAt,
    })
    this._dirty = false
  }

  // ---------------------------------------------------------------------------
  // Static API
  // ---------------------------------------------------------------------------

  /** Create a new anonymous session (not yet persisted — call save() or let the middleware handle it). */
  static create(ctx: Context): Session {
    const id = crypto.randomUUID()
    const csrfToken = randomHex(32)
    const ipAddress = ctx.header('x-forwarded-for') ?? null
    const userAgent = ctx.header('user-agent') ?? null
    const now = new Date()

    const session = new Session(id, null, csrfToken, {}, ipAddress, userAgent, now, now)
    session._dirty = true
    return session
  }

  /** Look up a session by ID. Returns null if not found. */
  static async find(id: string): Promise<Session | null> {
    const record = await SessionManager.store.find(id)
    if (!record) return null
    return Session.fromRecord(record)
  }

  /** Read the session cookie from the request and look up the session. */
  static async fromRequest(ctx: Context): Promise<Session | null> {
    const sessionId = ctx.cookie(SessionManager.config.cookie)
    if (!sessionId) return null
    return Session.find(sessionId)
  }

  /** Delete the session from the store and clear the cookie on the response. */
  static async destroy(ctx: Context, response: Response): Promise<Response> {
    const cfg = SessionManager.config
    const sessionId = ctx.cookie(cfg.cookie)

    if (sessionId) {
      await SessionManager.store.destroy(sessionId)
    }

    return clearCookie(response, cfg.cookie, { path: '/' })
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private static fromRecord(record: SessionRecord): Session {
    return new Session(
      record.id,
      record.userId,
      record.csrfToken,
      record.data,
      record.ipAddress,
      record.userAgent,
      record.lastActivity,
      record.createdAt
    )
  }
}
