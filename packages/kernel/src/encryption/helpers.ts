import EncryptionManager from './encryption_manager.ts'

/**
 * Encryption helper — the primary API for all cryptographic operations.
 *
 * Uses the configured APP_KEY for symmetric encryption and HMAC signing.
 * Password hashing uses argon2id via Bun.password (no key needed).
 *
 * @example
 * import { encrypt } from '@strav/kernel/encryption'
 *
 * // Encrypt & decrypt strings
 * const encrypted = encrypt.encrypt('sensitive data')
 * const decrypted = encrypt.decrypt(encrypted)
 *
 * // Seal & unseal objects (JSON + encryption)
 * const token = encrypt.seal({ userId: 123 })
 * const data = encrypt.unseal<{ userId: number }>(token)
 *
 * // Password hashing
 * const hash = await encrypt.hash('password123')
 * const valid = await encrypt.verify('password123', hash)
 *
 * // HMAC signing
 * const sig = encrypt.sign('payload')
 * const ok = encrypt.verifySignature('payload', sig)
 */
export const encrypt = {
  /**
   * Encrypt a string using AES-256-GCM. Returns a base64url-encoded payload.
   *
   * @example
   * const encrypted = encrypt.encrypt('my secret')
   * // Store `encrypted` in the database — it's a safe, opaque string
   */
  encrypt(plaintext: string): string {
    return EncryptionManager.encrypt(plaintext)
  },

  /**
   * Decrypt a payload encrypted with `encrypt()`.
   * Supports key rotation — tries previous keys if the current key fails.
   *
   * @example
   * const original = encrypt.decrypt(encrypted) // 'my secret'
   */
  decrypt(payload: string): string {
    return EncryptionManager.decrypt(payload)
  },

  /**
   * Encrypt and serialize an object. Perfect for tamper-proof cookies or tokens.
   *
   * @example
   * const token = encrypt.seal({ userId: 123, role: 'admin' })
   * // Send `token` to the client — it's encrypted and tamper-proof
   */
  seal(data: unknown): string {
    return EncryptionManager.seal(data)
  },

  /**
   * Decrypt and deserialize an object sealed with `seal()`.
   *
   * @example
   * const data = encrypt.unseal<{ userId: number }>(token)
   * console.log(data.userId) // 123
   */
  unseal<T = unknown>(payload: string): T {
    return EncryptionManager.unseal<T>(payload)
  },

  /**
   * Hash a password using argon2id. Returns an encoded hash string.
   *
   * @example
   * const hash = await encrypt.hash(formData.password)
   * await db.sql`UPDATE users SET password = ${hash} WHERE id = ${userId}`
   */
  hash(password: string): Promise<string> {
    return EncryptionManager.hash(password)
  },

  /**
   * Verify a password against a hash. Works with argon2id and bcrypt.
   *
   * @example
   * const valid = await encrypt.verify(formData.password, user.password)
   * if (!valid) throw new Error('Invalid credentials')
   */
  verify(password: string, hash: string): Promise<boolean> {
    return EncryptionManager.verify(password, hash)
  },

  /**
   * Create an HMAC-SHA256 signature. Returns a hex string.
   *
   * @example
   * const sig = encrypt.sign(`${webhookId}:${timestamp}:${body}`)
   * response.headers.set('X-Signature', sig)
   */
  sign(data: string): string {
    return EncryptionManager.sign(data)
  },

  /**
   * Verify an HMAC-SHA256 signature (timing-safe).
   * Supports key rotation — tries previous keys if the current key fails.
   *
   * @example
   * const valid = encrypt.verifySignature(body, req.headers.get('X-Signature')!)
   * if (!valid) return new Response('Invalid signature', { status: 401 })
   */
  verifySignature(data: string, signature: string): boolean {
    return EncryptionManager.verifySignature(data, signature)
  },

  /**
   * Deterministic HMAC fingerprint for indexing encrypted columns.
   *
   * Pair with `encrypt.encrypt(value)` to support equality lookups against
   * encrypted PII (e.g. find a user by email without storing the email in
   * plaintext). `context` separates the index space across columns so two
   * tables can't be correlated even by an attacker holding the database.
   *
   * @example
   * const email = formData.email.trim().toLowerCase()
   * await db.sql`
   *   INSERT INTO users (email_encrypted, email_index)
   *   VALUES (${encrypt.encrypt(email)}, ${encrypt.blindIndex(email, 'users.email')})
   * `
   */
  blindIndex(value: string, context: string = 'default', options: { length?: number } = {}): string {
    return EncryptionManager.blindIndex(value, context, options)
  },

  /**
   * Encrypt a value AND compute its blind index in one call. Convenience
   * for the searchable-encryption pattern.
   *
   * @example
   * const { encrypted, index } = encrypt.searchablePair(email, 'users.email')
   */
  searchablePair(
    value: string,
    context: string = 'default',
    options: { length?: number } = {}
  ): { encrypted: string; index: string } {
    return EncryptionManager.searchablePair(value, context, options)
  },

  /**
   * SHA-256 hash. Returns a hex string.
   *
   * @example
   * const checksum = encrypt.sha256(fileContents)
   */
  sha256(data: string): string {
    return EncryptionManager.sha256(data)
  },

  /**
   * SHA-512 hash. Returns a hex string.
   *
   * @example
   * const hash = encrypt.sha512(data)
   */
  sha512(data: string): string {
    return EncryptionManager.sha512(data)
  },

  /**
   * Generate a random hex string. Default: 32 bytes → 64 hex chars.
   *
   * @example
   * const apiKey = encrypt.random()       // 64-char hex (32 bytes)
   * const shortToken = encrypt.random(16) // 32-char hex (16 bytes)
   */
  random(bytes: number = 32): string {
    return EncryptionManager.random(bytes)
  },

  /**
   * Generate raw random bytes.
   *
   * @example
   * const iv = encrypt.randomBytes(12)
   */
  randomBytes(bytes: number = 32): Uint8Array {
    return EncryptionManager.randomBytes(bytes)
  },
}
