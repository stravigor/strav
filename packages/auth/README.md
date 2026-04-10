# @strav/auth

Authentication primitives for the [Strav](https://strav.dev) framework. Provides unopinionated, composable utilities for building secure authentication systems.

## Install

```bash
bun add @strav/auth
```

Requires `@strav/kernel` as a peer dependency.

## Features

- **JWT Management** - Sign and verify JWTs using the jose library
- **Token Utilities** - Signed opaque tokens, magic links, refresh tokens
- **TOTP/2FA** - Time-based one-time passwords and recovery codes
- **Password Validation** - Strength checking and policy enforcement
- **OAuth Helpers** - State management for OAuth flows

## Usage

### JWT Operations

```ts
import { signJWT, verifyJWT, createAccessToken, verifyAccessToken } from '@strav/auth'

// Sign a JWT
const token = await signJWT(
  { userId: 123, role: 'admin' },
  'your-secret-key',
  { expiresIn: '1h', issuer: 'my-app' }
)

// Verify a JWT
const payload = await verifyJWT(token, 'your-secret-key', {
  issuer: 'my-app'
})

// Create access/refresh token pairs
const accessToken = await createAccessToken(userId, secret)
const userId = await verifyAccessToken(accessToken, secret)
```

### TOTP / Two-Factor Authentication

```ts
import { generateSecret, verifyTotp, totpUri, generateRecoveryCodes } from '@strav/auth'

// Generate a secret for a user
const { raw, base32 } = generateSecret()

// Create QR code URI for authenticator apps
const uri = totpUri({
  secret: base32,
  issuer: 'MyApp',
  account: 'user@example.com'
})

// Verify a TOTP code
const valid = await verifyTotp(raw, '123456')

// Generate recovery codes
const codes = generateRecoveryCodes(8)
```

### Password Validation

```ts
import { validatePassword, calculatePasswordStrength, generatePassword } from '@strav/auth'

// Validate against a policy
const result = validatePassword(password, {
  minLength: 12,
  requireUppercase: true,
  requireNumbers: true,
  requireSpecialChars: true
})

if (!result.valid) {
  console.log(result.errors)
}

// Calculate password strength
const strength = calculatePasswordStrength(password)
console.log(strength.score, strength.label) // 0-4, "Very Weak" to "Very Strong"

// Generate a secure password
const password = generatePassword(16)
```

### Signed Opaque Tokens

```ts
import { createSignedToken, verifySignedToken } from '@strav/auth'

// Create an encrypted, tamper-proof token
const token = createSignedToken(
  { sub: userId, typ: 'password-reset' },
  60 // expires in 60 minutes
)

// Verify and decode
const payload = verifySignedToken(token)
```

### Magic Links

```ts
import { createMagicLinkToken, verifyMagicLinkToken } from '@strav/auth'

// Create a magic link token
const token = createMagicLinkToken(userId, {
  email: 'user@example.com',
  redirect: '/dashboard',
  expiresInMinutes: 15
})

// Verify the token
const payload = verifyMagicLinkToken(token)
```

### OAuth State Management

```ts
import { createOAuthStateStore } from '@strav/auth'

// Create a state store (implement storage backend)
const stateStore = createOAuthStateStore({
  async store(state) { /* save to Redis/DB */ },
  async retrieve(value) { /* fetch from storage */ },
  async delete(value) { /* remove from storage */ },
  ttl: 600 // 10 minutes
})

// Generate state for OAuth flow
const stateValue = await stateStore.generate({
  redirect: '/dashboard',
  data: { provider: 'github' }
})

// Verify state after OAuth callback
const state = await stateStore.verify(stateValue)
```

## Architecture

This package provides low-level authentication primitives without imposing any specific authentication flow or pattern. It's designed to be:

- **Unopinionated** - Build any authentication pattern you need
- **Composable** - Mix and match utilities as required
- **Secure** - Uses modern standards and best practices
- **Framework-agnostic** - Works with any HTTP framework

## License

MIT