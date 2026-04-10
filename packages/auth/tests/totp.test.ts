import { describe, test, expect } from 'bun:test'
import {
  generateSecret,
  generateTotp,
  verifyTotp,
  base32Encode,
  base32Decode,
  generateRecoveryCodes,
  totpUri,
} from '../src/totp/index.ts'

describe('TOTP utilities', () => {
  test('generateSecret creates valid secrets', () => {
    const { raw, base32 } = generateSecret()

    expect(raw).toBeInstanceOf(Uint8Array)
    expect(raw).toHaveLength(20) // 20 bytes
    expect(base32).toMatch(/^[A-Z2-7]+$/) // Valid base32
    expect(base32.length).toBeGreaterThan(0)
  })

  test('base32 encoding and decoding', () => {
    const data = new Uint8Array([72, 101, 108, 108, 111]) // "Hello"
    const encoded = base32Encode(data)
    expect(encoded).toBe('JBSWY3DP')

    const decoded = base32Decode(encoded)
    expect(Array.from(decoded)).toEqual(Array.from(data))
  })

  test('generateTotp and verifyTotp work together', async () => {
    const { raw } = generateSecret()

    // Generate a code
    const code = await generateTotp(raw)
    expect(code).toMatch(/^\d{6}$/) // 6 digits

    // Verify the same code
    const valid = await verifyTotp(raw, code)
    expect(valid).toBe(true)

    // Wrong code should fail
    const invalid = await verifyTotp(raw, '000000')
    expect(invalid).toBe(false)
  })

  test('generateRecoveryCodes creates unique codes', () => {
    const codes = generateRecoveryCodes(8)

    expect(codes).toHaveLength(8)
    codes.forEach(code => {
      expect(code).toMatch(/^[0-9a-f]{8}$/) // 8 hex chars
    })

    // Check uniqueness
    const unique = new Set(codes)
    expect(unique.size).toBe(8)
  })

  test('totpUri generates valid URI', () => {
    const uri = totpUri({
      secret: 'JBSWY3DPEHPK3PXP',
      issuer: 'TestApp',
      account: 'user@example.com',
    })

    expect(uri).toContain('otpauth://totp/')
    expect(uri).toContain('TestApp')
    expect(uri).toContain('user%40example.com')
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP')
    expect(uri).toContain('issuer=TestApp')
    expect(uri).toContain('algorithm=SHA1')
    expect(uri).toContain('digits=6')
    expect(uri).toContain('period=30')
  })
})