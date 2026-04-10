/**
 * Recovery code generation for two-factor authentication.
 */

/** Generate a set of single-use recovery codes (8-char hex each). */
export function generateRecoveryCodes(count: number): string[] {
  const codes: string[] = []
  for (let i = 0; i < count; i++) {
    const bytes = crypto.getRandomValues(new Uint8Array(4))
    codes.push(Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''))
  }
  return codes
}