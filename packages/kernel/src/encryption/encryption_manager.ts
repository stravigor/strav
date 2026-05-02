import {
  hkdfSync,
  createCipheriv,
  createDecipheriv,
  createHmac,
  timingSafeEqual,
} from 'node:crypto'
import { inject } from '../core/inject.ts'
import Configuration from '../config/configuration.ts'
import type { EncryptionConfig } from './types.ts'
import { ConfigurationError, EncryptionError } from '../exceptions/errors.ts'

const IV_LENGTH = 12
const TAG_LENGTH = 16
const KEY_LENGTH = 32
const ALGORITHM = 'aes-256-gcm'
const HKDF_SALT = 'strav-encryption-salt'

function deriveKey(raw: string, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', raw, HKDF_SALT, info, KEY_LENGTH))
}

function encryptWithKey(plaintext: string, key: Buffer): string {
  const iv = Buffer.from(crypto.getRandomValues(new Uint8Array(IV_LENGTH)))
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // iv (12) + ciphertext (variable) + tag (16)
  const payload = Buffer.concat([iv, encrypted, tag])
  return payload.toString('base64url')
}

function decryptWithKey(payload: string, key: Buffer): string {
  const buf = Buffer.from(payload, 'base64url')
  if (buf.length < IV_LENGTH + TAG_LENGTH) {
    throw new EncryptionError('Invalid encrypted payload: too short.')
  }
  const iv = buf.subarray(0, IV_LENGTH)
  const tag = buf.subarray(buf.length - TAG_LENGTH)
  const ciphertext = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(ciphertext) + decipher.final('utf8')
}

/**
 * Central encryption configuration hub.
 *
 * Resolved once via the DI container — reads the encryption config
 * and derives cryptographic keys from the application key.
 *
 * @example
 * app.singleton(EncryptionManager)
 * app.resolve(EncryptionManager)
 *
 * // Swap keys at runtime (e.g., for testing)
 * EncryptionManager.useKey('test-key-here')
 */
@inject
export default class EncryptionManager {
  private static _config: EncryptionConfig
  private static _encryptionKey: Buffer
  private static _hmacKey: Buffer
  private static _previousEncryptionKeys: Buffer[]
  private static _previousHmacKeys: Buffer[]
  /** Lazily derived per-context blind-index keys. Cleared on `useKey`. */
  private static _blindIndexKeys: Map<string, Buffer> = new Map()

  constructor(config: Configuration) {
    EncryptionManager._config = {
      key: '',
      previousKeys: [],
      ...(config.get('encryption', {}) as object),
    }

    const raw = EncryptionManager._config.key
    if (!raw) {
      throw new ConfigurationError(
        'Encryption key is not set. Set APP_KEY in your .env file or configure encryption.key.'
      )
    }

    EncryptionManager._encryptionKey = deriveKey(raw, 'aes-256-gcm')
    EncryptionManager._hmacKey = deriveKey(raw, 'hmac-sha256')

    EncryptionManager._previousEncryptionKeys = EncryptionManager._config.previousKeys.map(k =>
      deriveKey(k, 'aes-256-gcm')
    )
    EncryptionManager._previousHmacKeys = EncryptionManager._config.previousKeys.map(k =>
      deriveKey(k, 'hmac-sha256')
    )
  }

  static get config(): EncryptionConfig {
    return EncryptionManager._config
  }

  /** Swap the application key at runtime (e.g., for testing). */
  static useKey(key: string): void {
    if (EncryptionManager._config) {
      EncryptionManager._config.key = key
    } else {
      EncryptionManager._config = { key, previousKeys: [] }
    }
    EncryptionManager._encryptionKey = deriveKey(key, 'aes-256-gcm')
    EncryptionManager._hmacKey = deriveKey(key, 'hmac-sha256')
    EncryptionManager._blindIndexKeys.clear()
  }

  // ---------------------------------------------------------------------------
  // Symmetric Encryption (AES-256-GCM)
  // ---------------------------------------------------------------------------

  /** Encrypt a plaintext string. Returns a base64url-encoded payload. */
  static encrypt(plaintext: string): string {
    return encryptWithKey(plaintext, EncryptionManager._encryptionKey)
  }

  /**
   * Decrypt a payload. Tries the current key first, then previous keys for rotation.
   * Throws if none of the keys can decrypt the payload.
   */
  static decrypt(payload: string): string {
    try {
      return decryptWithKey(payload, EncryptionManager._encryptionKey)
    } catch {
      // Try previous keys for rotation
      for (const key of EncryptionManager._previousEncryptionKeys) {
        try {
          return decryptWithKey(payload, key)
        } catch {
          continue
        }
      }
      throw new EncryptionError('Decryption failed: invalid payload or key.')
    }
  }

  /** Encrypt and JSON-serialize an object. */
  static seal(data: unknown): string {
    return EncryptionManager.encrypt(JSON.stringify(data))
  }

  /** Decrypt and JSON-deserialize an object. */
  static unseal<T = unknown>(payload: string): T {
    return JSON.parse(EncryptionManager.decrypt(payload)) as T
  }

  // ---------------------------------------------------------------------------
  // HMAC Signing
  // ---------------------------------------------------------------------------

  /** Create an HMAC-SHA256 signature. Returns a hex string. */
  static sign(data: string): string {
    return createHmac('sha256', EncryptionManager._hmacKey).update(data).digest('hex')
  }

  /**
   * Verify an HMAC-SHA256 signature using timing-safe comparison.
   * Tries the current key first, then previous keys for rotation.
   */
  static verifySignature(data: string, signature: string): boolean {
    const expected = Buffer.from(EncryptionManager.sign(data), 'hex')
    const actual = Buffer.from(signature, 'hex')
    if (expected.length !== actual.length) {
      // Try previous keys
      for (const key of EncryptionManager._previousHmacKeys) {
        const prev = Buffer.from(createHmac('sha256', key).update(data).digest('hex'), 'hex')
        if (prev.length === actual.length && timingSafeEqual(prev, actual)) return true
      }
      return false
    }
    if (timingSafeEqual(expected, actual)) return true
    // Try previous keys
    for (const key of EncryptionManager._previousHmacKeys) {
      const prev = Buffer.from(createHmac('sha256', key).update(data).digest('hex'), 'hex')
      if (prev.length === actual.length && timingSafeEqual(prev, actual)) return true
    }
    return false
  }

  // ---------------------------------------------------------------------------
  // Searchable encryption (blind index)
  // ---------------------------------------------------------------------------

  /**
   * Deterministic HMAC fingerprint suitable for indexing encrypted values.
   *
   * Use case: store an email or phone number as `encrypt(value)` for at-rest
   * confidentiality, plus `blindIndex(value, 'users.email')` in a separate
   * indexable column. Lookups become `WHERE email_index = $blind_index`,
   * keeping the plaintext unrecoverable from the database while still
   * supporting equality queries.
   *
   * `context` provides domain separation between blind indexes for different
   * columns / tables. Two indexes with different contexts cannot be
   * correlated even by an attacker who has the database — the keys are
   * derived independently from `APP_KEY` via HKDF.
   *
   * Length truncation is supported (in bytes; default = full SHA-256, 32
   * bytes / 64 hex chars). Truncating reduces collision resistance — at 8
   * bytes you'd expect a collision around the 4-billionth value, so don't
   * truncate aggressively for high-cardinality data.
   *
   * Important — the caller is responsible for normalizing the input before
   * calling: lowercase emails, strip phone-number formatting, trim whitespace.
   * The same input must produce the same index, including from the receive
   * side (when looking up by user-supplied value).
   *
   * Rotation note: blind indexes do NOT support `previousKeys` fallback,
   * because lookups are direct equality queries against the stored value.
   * Rotating `APP_KEY` requires re-computing every stored blind index — plan
   * a migration with parallel index columns.
   *
   * @example
   * const email = formData.email.trim().toLowerCase()
   * await db.sql`
   *   INSERT INTO users (email_encrypted, email_index)
   *   VALUES (${encrypt.encrypt(email)}, ${encrypt.blindIndex(email, 'users.email')})
   * `
   *
   * // Lookup
   * const idx = encrypt.blindIndex(email, 'users.email')
   * const rows = await db.sql`SELECT * FROM users WHERE email_index = ${idx}`
   */
  static blindIndex(
    value: string,
    context: string = 'default',
    options: { length?: number } = {}
  ): string {
    if (!EncryptionManager._config?.key) {
      throw new ConfigurationError(
        'EncryptionManager is not configured. Resolve it through the container or call useKey().'
      )
    }
    let key = EncryptionManager._blindIndexKeys.get(context)
    if (!key) {
      key = deriveKey(EncryptionManager._config.key, `blind-index:${context}`)
      EncryptionManager._blindIndexKeys.set(context, key)
    }
    const hex = createHmac('sha256', key).update(value).digest('hex')
    if (options.length === undefined) return hex
    const charCount = Math.max(2, Math.min(64, options.length * 2))
    return hex.slice(0, charCount)
  }

  /**
   * Convenience: encrypt a value AND compute its blind index in one call.
   * Returns `{ encrypted, index }` ready to be stored in a pair of columns.
   */
  static searchablePair(
    value: string,
    context: string = 'default',
    options: { length?: number } = {}
  ): { encrypted: string; index: string } {
    return {
      encrypted: EncryptionManager.encrypt(value),
      index: EncryptionManager.blindIndex(value, context, options),
    }
  }

  // ---------------------------------------------------------------------------
  // Password Hashing (Bun.password — argon2id)
  // ---------------------------------------------------------------------------

  /** Hash a password using argon2id. Returns an encoded hash string. */
  static hash(password: string): Promise<string> {
    return Bun.password.hash(password, 'argon2id')
  }

  /** Verify a password against a hash. Works with argon2id and bcrypt hashes. */
  static verify(password: string, hash: string): Promise<boolean> {
    return Bun.password.verify(password, hash)
  }

  // ---------------------------------------------------------------------------
  // One-way Hashing
  // ---------------------------------------------------------------------------

  /** SHA-256 hash. Returns a hex string. */
  static sha256(data: string): string {
    return new Bun.CryptoHasher('sha256').update(data).digest('hex')
  }

  /** SHA-512 hash. Returns a hex string. */
  static sha512(data: string): string {
    return new Bun.CryptoHasher('sha512').update(data).digest('hex')
  }

  // ---------------------------------------------------------------------------
  // Random Generation
  // ---------------------------------------------------------------------------

  /** Generate a random hex string (2 hex chars per byte). */
  static random(bytes: number = 32): string {
    return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('hex')
  }

  /** Generate raw random bytes. */
  static randomBytes(bytes: number = 32): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(bytes))
  }
}
