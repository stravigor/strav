/**
 * QR code URI generation for TOTP authenticators.
 */

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