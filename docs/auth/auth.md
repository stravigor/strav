# Auth

The auth module (`@strav/auth`) provides unopinionated, composable authentication primitives for building secure authentication systems. Unlike opinionated authentication frameworks, this package gives you the building blocks to implement any authentication pattern you need.

## Installation

```bash
bun add @strav/auth
```

Requires `@strav/kernel` as a peer dependency for encryption utilities.

## Architecture

The auth package is organized into five main areas:

### 1. JWT Operations
Zero-dependency JWT implementation using built-in Node.js/Bun crypto APIs, providing secure and standards-compliant token operations.

### 2. Token Management
Various token types for different authentication scenarios - signed opaque tokens, magic links, and refresh tokens.

### 3. TOTP / Two-Factor Authentication
Complete TOTP implementation following RFC 6238, including QR code generation and recovery codes.

### 4. Password Validation
Comprehensive password strength checking and policy enforcement utilities.

### 5. OAuth Helpers
State management for OAuth flows with CSRF protection.

## JWT Operations

### Basic JWT Operations

```typescript
import { signJWT, verifyJWT } from '@strav/auth'

// Sign a JWT with custom claims
const token = await signJWT(
  {
    userId: 123,
    role: 'admin',
    permissions: ['read', 'write']
  },
  'your-secret-key',
  {
    expiresIn: '1h',
    issuer: 'my-app',
    audience: 'api.example.com'
  }
)

// Verify and extract payload
const payload = await verifyJWT(token, 'your-secret-key', {
  issuer: 'my-app',
  audience: 'api.example.com',
  requiredClaims: ['userId', 'role']
})
```

### Access and Refresh Tokens

```typescript
import { createAccessToken, verifyAccessToken, createRefreshToken, verifyRefreshToken } from '@strav/auth'

// Create token pair
const accessToken = await createAccessToken(
  userId,
  secret,
  { email: 'user@example.com', role: 'admin' }, // Additional claims
  { expiresIn: '15m' }
)

const refreshToken = await createRefreshToken(
  userId,
  secret,
  { expiresIn: '30d' }
)

// Verify tokens
const userId = await verifyAccessToken(accessToken, secret)
const refreshUserId = await verifyRefreshToken(refreshToken, secret)
```

### Decode Without Verification

```typescript
import { decodeJWT } from '@strav/auth'

// Decode for inspection (DO NOT use for authentication!)
const payload = decodeJWT(token)
console.log('Token expires at:', new Date(payload.exp! * 1000))
```

## TOTP / Two-Factor Authentication

### Generate TOTP Secret

```typescript
import { generateSecret, totpUri } from '@strav/auth'

// Generate a new secret for a user
const { raw, base32 } = generateSecret()

// Save raw to database (encrypted)
await saveUserSecret(userId, raw)

// Generate QR code URI for authenticator apps
const uri = totpUri({
  secret: base32,
  issuer: 'MyApp',
  account: user.email,
  digits: 6,
  period: 30
})

// Show QR code to user using the URI
```

### Verify TOTP Codes

```typescript
import { verifyTotp } from '@strav/auth'

// Get user's secret from database
const secret = await getUserSecret(userId)

// Verify the 6-digit code from user
const isValid = await verifyTotp(
  secret,
  userInputCode,
  {
    window: 1, // Allow 1 time step before/after for clock drift
    digits: 6,
    period: 30
  }
)

if (!isValid) {
  throw new Error('Invalid 2FA code')
}
```

### Recovery Codes

```typescript
import { generateRecoveryCodes } from '@strav/auth'

// Generate single-use recovery codes
const codes = generateRecoveryCodes(8)

// Hash and store these securely
for (const code of codes) {
  await storeRecoveryCode(userId, await encrypt.hash(code))
}

// Show codes to user ONCE
return { recoveryCodes: codes }
```

## Password Validation

### Validate Against Policy

```typescript
import { validatePassword, type PasswordPolicy } from '@strav/auth'

const policy: PasswordPolicy = {
  minLength: 12,
  maxLength: 128,
  requireUppercase: true,
  requireLowercase: true,
  requireNumbers: true,
  requireSpecialChars: true,
  blacklist: ['password', 'company', '12345'],
  customValidator: (pwd) => {
    // Custom business logic
    if (pwd.includes(username)) {
      return { valid: false, message: 'Password cannot contain username' }
    }
    return { valid: true }
  }
}

const result = validatePassword(userInput, policy)

if (!result.valid) {
  // Show errors to user
  return { errors: result.errors }
}
```

### Calculate Password Strength

```typescript
import { calculatePasswordStrength } from '@strav/auth'

const strength = calculatePasswordStrength(password)

// strength.score: 0-4 (Very Weak to Very Strong)
// strength.label: Human-readable label
// strength.issues: Specific problems found
// strength.suggestions: How to improve

if (strength.score < 3) {
  return {
    message: `Password is ${strength.label}`,
    suggestions: strength.suggestions
  }
}
```

### Generate Secure Passwords

```typescript
import { generatePassword } from '@strav/auth'

// Generate a 16-character password with all character types
const password = generatePassword(16)

// Generate without symbols (for compatibility)
const simplePassword = generatePassword(20, {
  uppercase: true,
  lowercase: true,
  numbers: true,
  symbols: false
})
```

## Token Management

### Signed Opaque Tokens

These tokens are encrypted and tamper-proof, perfect for email verification, password reset, etc.

```typescript
import { createSignedToken, verifySignedToken } from '@strav/auth'

// Create a password reset token
const token = createSignedToken(
  {
    sub: userId,
    typ: 'password-reset',
    email: user.email
  },
  60 // Expires in 60 minutes
)

// Send token in email
await sendEmail(user.email, `Reset your password: ${url}?token=${token}`)

// Later, verify the token
try {
  const payload = verifySignedToken(token)

  if (payload.typ !== 'password-reset') {
    throw new Error('Invalid token type')
  }

  // Proceed with password reset for payload.sub
} catch (error) {
  // Token is invalid, expired, or tampered
}
```

### Magic Link Tokens

Specialized tokens for passwordless authentication.

```typescript
import { createMagicLinkToken, verifyMagicLinkToken } from '@strav/auth'

// Create magic link
const token = createMagicLinkToken(userId, {
  email: user.email,
  redirect: '/dashboard',
  expiresInMinutes: 15
})

const magicLink = `https://app.com/auth/magic?token=${token}`
await sendEmail(user.email, `Click to login: ${magicLink}`)

// Verify when user clicks link
try {
  const payload = verifyMagicLinkToken(token)

  // Log user in as payload.sub
  // Redirect to payload.redirect if provided
} catch (error) {
  // Token invalid or expired
}
```

### Refresh Token Management

Build a token rotation strategy with storage.

```typescript
import { createTokenRotation, generateRefreshToken } from '@strav/auth'

// Create rotation strategy with your storage backend
const rotation = createTokenRotation({
  async store(userId, token, expiresAt) {
    await db.refreshTokens.create({
      userId,
      token,
      expiresAt,
      deviceId: getDeviceId()
    })
  },

  async verify(token) {
    const record = await db.refreshTokens.findByToken(token)

    if (!record || record.expiresAt < new Date()) {
      return null
    }

    return record.userId
  },

  async revoke(token) {
    await db.refreshTokens.deleteByToken(token)
  },

  async revokeAll(userId) {
    await db.refreshTokens.deleteByUserId(userId)
  }
})

// Generate new refresh token
const refreshToken = await rotation.generate(userId, 2592000) // 30 days

// Verify and rotate
const userId = await rotation.verify(refreshToken)
if (userId) {
  // Revoke old token
  await rotation.revoke(refreshToken)

  // Issue new token pair
  const newRefresh = await rotation.generate(userId)
  const newAccess = await createAccessToken(userId, secret)
}
```

## OAuth State Management

Protect against CSRF attacks in OAuth flows.

```typescript
import { createOAuthStateStore } from '@strav/auth'

// Create state store (use Redis/DB in production)
const stateStore = createOAuthStateStore({
  async store(state) {
    await redis.setex(`oauth:${state.value}`, 600, JSON.stringify(state))
  },

  async retrieve(value) {
    const data = await redis.get(`oauth:${value}`)
    return data ? JSON.parse(data) : null
  },

  async delete(value) {
    await redis.del(`oauth:${value}`)
  },

  ttl: 600 // 10 minutes
})

// Before redirecting to OAuth provider
const stateValue = await stateStore.generate({
  redirect: '/dashboard',
  data: { provider: 'github' }
})

const authUrl = `https://github.com/login/oauth/authorize?state=${stateValue}&...`

// After OAuth callback
const state = await stateStore.verify(req.query.state)

if (!state) {
  throw new Error('Invalid or expired state')
}

// Continue with OAuth flow
// Use state.redirect and state.data as needed
```

## Integration Examples

### Complete Login Flow

```typescript
import { verifyAccessToken, createAccessToken, createRefreshToken } from '@strav/auth'
import { encrypt } from '@strav/kernel'

async function login(email: string, password: string) {
  // Find user
  const user = await User.findByEmail(email)
  if (!user) {
    throw new Error('Invalid credentials')
  }

  // Verify password
  const valid = await encrypt.verify(password, user.passwordHash)
  if (!valid) {
    throw new Error('Invalid credentials')
  }

  // Create tokens
  const accessToken = await createAccessToken(user.id, JWT_SECRET)
  const refreshToken = await createRefreshToken(user.id, JWT_SECRET)

  // Store refresh token
  await storeRefreshToken(user.id, refreshToken)

  return { accessToken, refreshToken }
}
```

### Protected Route Middleware

```typescript
import { verifyAccessToken } from '@strav/auth'

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '')

  if (!token) {
    return res.status(401).json({ error: 'No token provided' })
  }

  try {
    const userId = await verifyAccessToken(token, JWT_SECRET)
    req.user = await User.findById(userId)
    next()
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' })
  }
}
```

### Password Reset Flow

```typescript
import { createSignedToken, verifySignedToken, validatePassword } from '@strav/auth'

async function requestPasswordReset(email: string) {
  const user = await User.findByEmail(email)
  if (!user) {
    // Don't reveal if email exists
    return { message: 'If an account exists, you will receive an email' }
  }

  const token = createSignedToken(
    { sub: user.id, typ: 'password-reset' },
    60 // 1 hour
  )

  await sendResetEmail(email, token)
}

async function resetPassword(token: string, newPassword: string) {
  // Verify token
  const payload = verifySignedToken(token)
  if (payload.typ !== 'password-reset') {
    throw new Error('Invalid token')
  }

  // Validate new password
  const validation = validatePassword(newPassword, passwordPolicy)
  if (!validation.valid) {
    return { errors: validation.errors }
  }

  // Update password
  const user = await User.findById(payload.sub)
  user.passwordHash = await encrypt.hash(newPassword)
  await user.save()

  // Invalidate all sessions
  await revokeAllRefreshTokens(user.id)
}
```

## Security Considerations

1. **Zero Dependencies**: This package has no external dependencies, eliminating supply chain attack vectors that could compromise your authentication system
2. **Secret Management**: Store JWT secrets securely using environment variables and rotate them periodically
3. **Token Storage**: Never store tokens in localStorage for sensitive apps; use httpOnly cookies when possible
4. **Password Policies**: Enforce strong password requirements appropriate for your security needs
5. **TOTP Secrets**: Always encrypt TOTP secrets before storing in the database
6. **Recovery Codes**: Hash recovery codes before storage and mark as used after verification
7. **Rate Limiting**: Implement rate limiting on authentication endpoints
8. **Token Rotation**: Implement refresh token rotation to limit exposure window

