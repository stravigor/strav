import type { Context } from '@strav/http'

// ---------------------------------------------------------------------------
// Feature flags
// ---------------------------------------------------------------------------

export type Feature =
  | 'registration'
  | 'login'
  | 'logout'
  | 'password-reset'
  | 'email-verification'
  | 'two-factor'
  | 'password-confirmation'
  | 'update-password'
  | 'update-profile'

// ---------------------------------------------------------------------------
// Actions — the user-provided contract
// ---------------------------------------------------------------------------

export interface RegistrationData {
  name: string
  email: string
  password: string
  [key: string]: unknown
}

export interface JinaActions<TUser = unknown> {
  /** Create and persist a new user. Password is raw — hash it yourself. */
  createUser(data: RegistrationData): Promise<TUser>

  /** Find a user by email address. Return null if not found. */
  findByEmail(email: string): Promise<TUser | null>

  /** Find a user by primary key. Return null if not found. */
  findById(id: string | number): Promise<TUser | null>

  /** Return the stored password hash for verification. */
  passwordHashOf(user: TUser): string

  /** Return the user's email address. */
  emailOf(user: TUser): string

  /** Persist a new password. Password is raw — hash it yourself. */
  updatePassword(user: TUser, newPassword: string): Promise<void>

  // ─── Email verification (required when feature is enabled) ───────────

  /** Whether the user has verified their email. */
  isEmailVerified?(user: TUser): boolean

  /** Mark the user's email as verified. */
  markEmailVerified?(user: TUser): Promise<void>

  // ─── Two-factor authentication (required when feature is enabled) ────

  /** Return the TOTP secret, or null if 2FA is not enabled. */
  twoFactorSecretOf?(user: TUser): string | null

  /** Persist the TOTP secret (null to clear). */
  setTwoFactorSecret?(user: TUser, secret: string | null): Promise<void>

  /** Return the user's recovery codes. */
  recoveryCodesOf?(user: TUser): string[]

  /** Persist new recovery codes. */
  setRecoveryCodes?(user: TUser, codes: string[]): Promise<void>

  // ─── Profile update (required when feature is enabled) ───────────────

  /** Update the user's profile fields. */
  updateProfile?(user: TUser, data: Record<string, unknown>): Promise<void>
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Maximum requests in the window. */
  max: number
  /** Window duration in seconds. */
  window: number
}

export interface JinaConfig {
  features: Feature[]
  prefix: string
  mode: 'session' | 'token'
  routes: {
    /** Route group alias for authentication endpoints (e.g., 'jina.auth' or 'auth') */
    aliases: {
      auth: string
    }
    /** Optional subdomain for authentication routes */
    subdomain?: string
  }
  rateLimit: {
    login: RateLimitConfig
    register: RateLimitConfig
    forgotPassword: RateLimitConfig
    verifyEmail: RateLimitConfig
    twoFactor: RateLimitConfig
  }
  passwords: {
    expiration: number // minutes
  }
  verification: {
    expiration: number // minutes
  }
  confirmation: {
    timeout: number // seconds
  }
  twoFactor: {
    issuer: string
    digits: number
    period: number
    recoveryCodes: number
  }
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface JinaEvent<TUser = unknown> {
  user: TUser
  ctx: Context
}

export const JinaEvents = {
  REGISTERED: 'jina:registered',
  LOGIN: 'jina:login',
  LOGOUT: 'jina:logout',
  PASSWORD_RESET: 'jina:password-reset',
  EMAIL_VERIFIED: 'jina:email-verified',
  TWO_FACTOR_ENABLED: 'jina:two-factor-enabled',
  TWO_FACTOR_DISABLED: 'jina:two-factor-disabled',
  PASSWORD_CONFIRMED: 'jina:password-confirmed',
  PASSWORD_UPDATED: 'jina:password-updated',
  PROFILE_UPDATED: 'jina:profile-updated',
} as const
