/**
 * Password validation utilities for enforcing security policies.
 */

export interface PasswordStrength {
  /** Overall score from 0-4 (0 = very weak, 4 = very strong) */
  score: number
  /** Human-readable strength label */
  label: 'Very Weak' | 'Weak' | 'Fair' | 'Strong' | 'Very Strong'
  /** Specific issues with the password */
  issues: string[]
  /** Suggestions for improvement */
  suggestions: string[]
}

export interface PasswordPolicy {
  /** Minimum length (default: 8) */
  minLength?: number
  /** Maximum length (default: 128) */
  maxLength?: number
  /** Require at least one uppercase letter */
  requireUppercase?: boolean
  /** Require at least one lowercase letter */
  requireLowercase?: boolean
  /** Require at least one number */
  requireNumbers?: boolean
  /** Require at least one special character */
  requireSpecialChars?: boolean
  /** List of forbidden passwords/patterns */
  blacklist?: string[]
  /** Custom validation function */
  customValidator?: (password: string) => { valid: boolean; message?: string }
}

const DEFAULT_POLICY: PasswordPolicy = {
  minLength: 8,
  maxLength: 128,
  requireUppercase: false,
  requireLowercase: false,
  requireNumbers: false,
  requireSpecialChars: false,
}

/**
 * Check if a password meets the specified policy requirements.
 *
 * @param password - The password to validate
 * @param policy - The password policy to enforce
 * @returns Validation result with specific issues
 */
export function validatePassword(
  password: string,
  policy: PasswordPolicy = DEFAULT_POLICY
): { valid: boolean; errors: string[] } {
  const errors: string[] = []
  const p = { ...DEFAULT_POLICY, ...policy }

  // Length checks
  if (password.length < p.minLength!) {
    errors.push(`Password must be at least ${p.minLength} characters long`)
  }
  if (password.length > p.maxLength!) {
    errors.push(`Password must not exceed ${p.maxLength} characters`)
  }

  // Character requirements
  if (p.requireUppercase && !/[A-Z]/.test(password)) {
    errors.push('Password must contain at least one uppercase letter')
  }
  if (p.requireLowercase && !/[a-z]/.test(password)) {
    errors.push('Password must contain at least one lowercase letter')
  }
  if (p.requireNumbers && !/\d/.test(password)) {
    errors.push('Password must contain at least one number')
  }
  if (p.requireSpecialChars && !/[!@#$%^&*(),.?":{}|<>]/.test(password)) {
    errors.push('Password must contain at least one special character')
  }

  // Blacklist check
  if (p.blacklist) {
    const lowerPassword = password.toLowerCase()
    for (const forbidden of p.blacklist) {
      if (lowerPassword.includes(forbidden.toLowerCase())) {
        errors.push(`Password contains forbidden word: ${forbidden}`)
      }
    }
  }

  // Custom validation
  if (p.customValidator) {
    const result = p.customValidator(password)
    if (!result.valid && result.message) {
      errors.push(result.message)
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  }
}

/**
 * Calculate password strength using various heuristics.
 *
 * @param password - The password to analyze
 * @returns Strength assessment with score and suggestions
 */
export function calculatePasswordStrength(password: string): PasswordStrength {
  let score = 0
  const issues: string[] = []
  const suggestions: string[] = []

  // Length scoring
  if (password.length < 6) {
    issues.push('Too short')
    suggestions.push('Use at least 8 characters')
  } else if (password.length < 8) {
    score += 0.5
    suggestions.push('Consider using at least 8 characters')
  } else if (password.length < 12) {
    score += 1
  } else if (password.length < 16) {
    score += 1.5
  } else {
    score += 2
  }

  // Character diversity
  const hasLowercase = /[a-z]/.test(password)
  const hasUppercase = /[A-Z]/.test(password)
  const hasNumbers = /\d/.test(password)
  const hasSpecialChars = /[^a-zA-Z0-9]/.test(password)

  const diversity = [hasLowercase, hasUppercase, hasNumbers, hasSpecialChars].filter(Boolean).length

  if (diversity === 1) {
    issues.push('Uses only one type of character')
    suggestions.push('Mix uppercase, lowercase, numbers, and symbols')
  } else if (diversity === 2) {
    score += 0.5
    suggestions.push('Add numbers or symbols for better security')
  } else if (diversity === 3) {
    score += 1
  } else if (diversity === 4) {
    score += 1.5
  }

  // Common patterns detection
  if (/^[0-9]+$/.test(password)) {
    issues.push('Contains only numbers')
    score = Math.max(0, score - 1)
  }
  if (/^[a-zA-Z]+$/.test(password)) {
    issues.push('Contains only letters')
    score = Math.max(0, score - 0.5)
  }
  if (/(.)\1{2,}/.test(password)) {
    issues.push('Contains repeated characters')
    suggestions.push('Avoid repeating characters')
    score = Math.max(0, score - 0.5)
  }
  if (/(?:012|123|234|345|456|567|678|789|890|abc|bcd|cde|def)/i.test(password)) {
    issues.push('Contains sequential characters')
    suggestions.push('Avoid sequential patterns')
    score = Math.max(0, score - 0.5)
  }

  // Common passwords check
  const commonPasswords = ['password', '123456', 'qwerty', 'admin', 'letmein', 'welcome', 'monkey', 'dragon']
  const lowerPassword = password.toLowerCase()
  if (commonPasswords.some(common => lowerPassword.includes(common))) {
    issues.push('Contains common password pattern')
    suggestions.push('Avoid common words and patterns')
    score = Math.max(0, score - 2)
  }

  // Normalize score to 0-4 range
  score = Math.min(4, Math.max(0, score))

  // Determine label
  let label: PasswordStrength['label']
  if (score < 1) label = 'Very Weak'
  else if (score < 2) label = 'Weak'
  else if (score < 3) label = 'Fair'
  else if (score < 3.5) label = 'Strong'
  else label = 'Very Strong'

  return {
    score: Math.round(score),
    label,
    issues,
    suggestions: suggestions.slice(0, 3), // Limit to top 3 suggestions
  }
}

/**
 * Generate a random strong password.
 *
 * @param length - Password length (default: 16)
 * @param options - Character set options
 * @returns Generated password
 */
export function generatePassword(
  length: number = 16,
  options: {
    uppercase?: boolean
    lowercase?: boolean
    numbers?: boolean
    symbols?: boolean
  } = {}
): string {
  const opts = {
    uppercase: true,
    lowercase: true,
    numbers: true,
    symbols: true,
    ...options,
  }

  let charset = ''
  if (opts.lowercase) charset += 'abcdefghijklmnopqrstuvwxyz'
  if (opts.uppercase) charset += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  if (opts.numbers) charset += '0123456789'
  if (opts.symbols) charset += '!@#$%^&*()_+-=[]{}|;:,.<>?'

  if (!charset) {
    throw new Error('At least one character type must be enabled')
  }

  let password = ''
  const array = new Uint8Array(length)
  crypto.getRandomValues(array)

  for (let i = 0; i < length; i++) {
    password += charset[array[i]! % charset.length]!
  }

  return password
}