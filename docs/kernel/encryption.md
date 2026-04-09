# Encryption

Symmetric encryption, password hashing, HMAC signing, and random token generation — all backed by the application key.

## Setup

Generate an application key:

```bash
bun strav generate:key
```

This writes `APP_KEY` to your `.env` file. The key is required for `encrypt`, `decrypt`, `seal`, `unseal`, `sign`, and `verifySignature`.

Register the `EncryptionManager` using a service provider (recommended):

```typescript
import { EncryptionProvider } from '@strav/kernel'

app.use(new EncryptionProvider())
```

The `EncryptionProvider` depends on the `config` provider.

Or manually:

```typescript
import { EncryptionManager } from '@strav/kernel'

app.singleton(EncryptionManager)
app.resolve(EncryptionManager)
```

Create `config/encryption.ts`:

```typescript
import { env } from '@strav/kernel'

export default {
  key: env('APP_KEY', ''),
  previousKeys: [],
}
```

## Encryption helpers

The `encrypt` object is the primary API. All symmetric operations use AES-256-GCM with keys derived from your `APP_KEY`.

```typescript
import { encrypt } from '@strav/kernel'
```

### encrypt / decrypt

Encrypt and decrypt strings. Returns a compact base64url-encoded payload (safe for URLs, databases, cookies).

```typescript
const encrypted = encrypt.encrypt('sensitive data')
// 'eyJhbG...' — opaque, tamper-proof string

const original = encrypt.decrypt(encrypted)
// 'sensitive data'
```

Each call produces a unique ciphertext (random IV), so encrypting the same value twice yields different outputs.

### seal / unseal

Encrypt and JSON-serialize an object in one step. Perfect for tamper-proof cookies, tokens, or API payloads.

```typescript
const token = encrypt.seal({ userId: 123, role: 'admin' })
// Send to client — it's encrypted and tamper-proof

const data = encrypt.unseal<{ userId: number; role: string }>(token)
// { userId: 123, role: 'admin' }
```

### hash / verify (passwords)

Hash passwords using argon2id (via `Bun.password`). Each hash includes a unique salt automatically.

```typescript
const hash = await encrypt.hash(formData.password)
await db.sql`UPDATE users SET password = ${hash} WHERE id = ${userId}`

const valid = await encrypt.verify(formData.password, user.password)
if (!valid) throw new Error('Invalid credentials')
```

`verify` works with both argon2id and bcrypt hashes, so migrating from bcrypt is seamless.

### sign / verifySignature

Create and verify HMAC-SHA256 signatures. Uses timing-safe comparison to prevent timing attacks.

```typescript
// Signing outgoing webhooks
const payload = JSON.stringify(event)
const sig = encrypt.sign(payload)
response.headers.set('X-Signature', sig)

// Verifying incoming webhooks
const body = await request.text()
const signature = request.headers.get('X-Signature')!
if (!encrypt.verifySignature(body, signature)) {
  return new Response('Invalid signature', { status: 401 })
}
```

### sha256 / sha512

One-way hashing. Returns hex strings.

```typescript
const checksum = encrypt.sha256(fileContents)
const fingerprint = encrypt.sha512(data)
```

### random / randomBytes

Cryptographically secure random generation.

```typescript
const apiKey = encrypt.random()       // 64-char hex string (32 bytes)
const token = encrypt.random(16)      // 32-char hex string (16 bytes)
const iv = encrypt.randomBytes(12)    // raw Uint8Array
```

## Key rotation

When you rotate your `APP_KEY`, move the old key into `previousKeys` so existing encrypted data can still be decrypted:

```typescript
// config/encryption.ts
export default {
  key: env('APP_KEY', ''),
  previousKeys: [
    'old-key-abc123',    // retired key — still used for decryption
  ],
}
```

On `decrypt`, `unseal`, and `verifySignature`, the current key is tried first. If it fails, each previous key is tried in order. New encryptions and signatures always use the current key.

## Advanced usage

### Direct manager access

For runtime key swapping (e.g., in tests):

```typescript
import { EncryptionManager } from '@strav/kernel'

EncryptionManager.useKey('test-key-for-unit-tests')
```

## Controller example

```typescript
import { encrypt } from '@strav/kernel'

export default class ApiKeyController {
  async create(ctx: Context) {
    const user = ctx.get<User>('user')

    // Generate and store an encrypted API key
    const plain = encrypt.random()
    const hash = encrypt.sha256(plain)

    await db.sql`
      INSERT INTO api_keys (user_id, hash) VALUES (${user.id}, ${hash})
    `

    // Return the plain key once — it can never be recovered
    return ctx.json({ apiKey: plain })
  }

  async verify(ctx: Context) {
    const { apiKey } = await ctx.body<{ apiKey: string }>()
    const hash = encrypt.sha256(apiKey)

    const rows = await db.sql`
      SELECT * FROM api_keys WHERE hash = ${hash} LIMIT 1
    `

    if (rows.length === 0) {
      return ctx.json({ error: 'Invalid API key' }, 401)
    }

    return ctx.json({ valid: true, userId: rows[0].user_id })
  }
}
```
