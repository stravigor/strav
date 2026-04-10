import { describe, test, expect } from 'bun:test'
import {
  validatePassword,
  calculatePasswordStrength,
  generatePassword,
} from '../src/validation/index.ts'

describe('Password validation', () => {
  test('validatePassword with default policy', () => {
    const result1 = validatePassword('short')
    expect(result1.valid).toBe(false)
    expect(result1.errors).toContain('Password must be at least 8 characters long')

    const result2 = validatePassword('longenoughpassword')
    expect(result2.valid).toBe(true)
    expect(result2.errors).toHaveLength(0)
  })

  test('validatePassword with custom policy', () => {
    const policy = {
      minLength: 12,
      requireUppercase: true,
      requireLowercase: true,
      requireNumbers: true,
      requireSpecialChars: true,
    }

    const result1 = validatePassword('password', policy)
    expect(result1.valid).toBe(false)
    expect(result1.errors).toContain('Password must be at least 12 characters long')

    const result2 = validatePassword('simplepassword', policy)
    expect(result2.valid).toBe(false)
    expect(result2.errors).toContain('Password must contain at least one uppercase letter')

    const result3 = validatePassword('ComplexPass123!', policy)
    expect(result3.valid).toBe(true)
  })

  test('calculatePasswordStrength', () => {
    const weak = calculatePasswordStrength('123456')
    expect(weak.score).toBeLessThan(2)
    expect(weak.label).toMatch(/Weak|Very Weak/)
    expect(weak.issues.length).toBeGreaterThan(0)

    const fair = calculatePasswordStrength('Password123!')
    expect(fair.score).toBeGreaterThanOrEqual(1)
    expect(fair.score).toBeLessThanOrEqual(4)

    const strong = calculatePasswordStrength('MyC0mpl3x!P@ssw0rd#2024')
    expect(strong.score).toBeGreaterThanOrEqual(3)
    expect(strong.label).toMatch(/Strong|Very Strong/)
  })

  test('generatePassword creates valid passwords', () => {
    const password1 = generatePassword(16)
    expect(password1).toHaveLength(16)

    const password2 = generatePassword(24, {
      uppercase: true,
      lowercase: true,
      numbers: true,
      symbols: false,
    })
    expect(password2).toHaveLength(24)
    expect(/[!@#$%^&*]/.test(password2)).toBe(false) // No symbols

    // Check it has the required character types
    expect(/[a-z]/.test(password2)).toBe(true)
    expect(/[A-Z]/.test(password2)).toBe(true)
    expect(/\d/.test(password2)).toBe(true)
  })
})