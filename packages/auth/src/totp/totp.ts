/**
 * TOTP (Time-Based One-Time Password) implementation — RFC 6238.
 * Pure Bun crypto, zero external dependencies.
 */

import { timingSafeEqual as nodeTimingSafeEqual } from 'node:crypto'

// ---------------------------------------------------------------------------
// Base32 encoding/decoding (RFC 4648)
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(buffer: Uint8Array): string {
  let result = ''
  let bits = 0
  let value = 0

  for (const byte of buffer) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      result += BASE32_ALPHABET[(value >>> bits) & 0x1f]!
    }
  }

  if (bits > 0) {
    result += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f]!
  }

  return result
}

export function base32Decode(encoded: string): Uint8Array {
  const cleaned = encoded.replace(/=+$/, '').toUpperCase()
  const bytes: number[] = []
  let bits = 0
  let value = 0

  for (const char of cleaned) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) continue
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bits -= 8
      bytes.push((value >>> bits) & 0xff)
    }
  }

  return new Uint8Array(bytes)
}

// ---------------------------------------------------------------------------
// HOTP — RFC 4226
// ---------------------------------------------------------------------------

async function hotp(secret: Uint8Array, counter: bigint, digits: number): Promise<string> {
  // Counter as 8-byte big-endian buffer
  const counterBuffer = new ArrayBuffer(8)
  const view = new DataView(counterBuffer)
  view.setBigUint64(0, counter)

  // HMAC-SHA1
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, [
    'sign',
  ])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBuffer))

  // Dynamic truncation
  const offset = mac[19]! & 0x0f
  const code =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff)

  return String(code % 10 ** digits).padStart(digits, '0')
}

// ---------------------------------------------------------------------------
// TOTP — RFC 6238
// ---------------------------------------------------------------------------

export interface TotpOptions {
  digits?: number
  period?: number
  /** Number of time steps to check before/after current (handles clock drift). */
  window?: number
}

/** Generate a TOTP code for the given secret at the current time. */
export async function generateTotp(secret: Uint8Array, options: TotpOptions = {}): Promise<string> {
  const { digits = 6, period = 30 } = options
  const counter = BigInt(Math.floor(Date.now() / 1000 / period))
  return hotp(secret, counter, digits)
}

/** Verify a TOTP code, allowing for clock drift within the window. */
export async function verifyTotp(
  secret: Uint8Array,
  code: string,
  options: TotpOptions = {}
): Promise<boolean> {
  const { digits = 6, period = 30, window = 1 } = options
  const now = BigInt(Math.floor(Date.now() / 1000 / period))

  for (let i = -window; i <= window; i++) {
    const expected = await hotp(secret, now + BigInt(i), digits)
    if (timingSafeEqual(code, expected)) return true
  }

  return false
}

// ---------------------------------------------------------------------------
// Secret generation
// ---------------------------------------------------------------------------

/** Generate a random TOTP secret (20 bytes, returned as base32). */
export function generateSecret(): { raw: Uint8Array; base32: string } {
  const raw = crypto.getRandomValues(new Uint8Array(20))
  return { raw, base32: base32Encode(raw) }
}

/**
 * Build an `otpauth://` URI for QR code generation.
 * Compatible with Google Authenticator, Authy, 1Password, etc.
 */
export function totpUri(options: {
  secret: string // base32
  issuer: string
  account: string
  digits?: number
  period?: number
}): string {
  const { secret, issuer, account, digits = 6, period = 30 } = options
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(digits),
    period: String(period),
  })
  return `otpauth://totp/${label}?${params}`
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/** Generate a set of single-use recovery codes (8-char hex each). */
export function generateRecoveryCodes(count: number): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(4))
    codes.push(Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''))
  }
  return codes
}

// ---------------------------------------------------------------------------
// Timing-safe string comparison
// ---------------------------------------------------------------------------

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return nodeTimingSafeEqual(Buffer.from(a), Buffer.from(b))
}
