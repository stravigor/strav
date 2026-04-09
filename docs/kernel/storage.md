# Storage

File storage with local disk, S3-compatible, and Ostra backends. Two classes: `Storage` for file operations and `Upload` for validated ingestion.

## Quick start

```typescript
import { Storage, Upload } from '@strav/kernel'

// Store a file
const path = await Storage.put('avatars', file)          // 'avatars/a7f3c9d2.jpg'
const path = await Storage.putAs('avatars', file, 'me.jpg')

// Retrieve, check, delete
const blob = await Storage.get('avatars/a7f3c9d2.jpg')  // Blob | null
const exists = await Storage.exists('avatars/a7f3c9d2.jpg')
await Storage.delete('avatars/a7f3c9d2.jpg')

// URL generation
const url = Storage.url('avatars/a7f3c9d2.jpg')
// Local: '/storage/avatars/a7f3c9d2.jpg'
// S3:    presigned URL (default 1h expiry)
// Ostra: 'http://localhost:9000/buckets/my-bucket/avatars/a7f3c9d2.jpg'
```

## Upload (validated ingestion)

`Upload` wraps a `File`, validates it, and stores it via `Storage`:

```typescript
const { avatar } = await ctx.files('avatar')

const { path, url } = await Upload.file(avatar)
  .maxSize('5mb')
  .types(['image/jpeg', 'image/png', 'image/webp'])
  .store('avatars')
```

Both `maxSize()` and `types()` are optional. If validation fails, a typed error is thrown:

```typescript
import { FileTooLargeError, InvalidFileTypeError } from '@strav/kernel'

try {
  await Upload.file(file).maxSize('2mb').store('docs')
} catch (e) {
  if (e instanceof FileTooLargeError) { /* ... */ }
  if (e instanceof InvalidFileTypeError) { /* ... */ }
}
```

### Size format

Accepts a number (bytes) or a string: `'500b'`, `'5kb'`, `'10mb'`, `'1gb'`.

### Custom filename

Pass a name to `store()`:

```typescript
const { path } = await Upload.file(avatar).store('avatars', 'profile.jpg')
// 'avatars/profile.jpg'
```

Without a name, a random hex filename is generated with the original extension preserved.

## Configuration

Create `config/storage.ts`:

```typescript
import { env } from '@strav/kernel'

export default {
  default: env('STORAGE_DRIVER', 'local'),

  local: {
    root: env('STORAGE_LOCAL_ROOT', 'storage'),
    baseUrl: env('STORAGE_BASE_URL', '/storage'),
  },

  s3: {
    bucket: env('S3_BUCKET', ''),
    region: env('S3_REGION', 'us-east-1'),
    endpoint: env('S3_ENDPOINT', null),
    accessKeyId: env('S3_ACCESS_KEY_ID', ''),
    secretAccessKey: env('S3_SECRET_ACCESS_KEY', ''),
    baseUrl: env('S3_BASE_URL', null),
  },

  ostra: {
    url: env('OSTRA_URL', 'http://localhost:9000'),
    token: env('OSTRA_TOKEN', ''),
    bucket: env('OSTRA_BUCKET', ''),
  },
}
```

### Local driver

Stores files under the `root` directory using `Bun.write()`. URLs are path-based using the `baseUrl` prefix. Serve stored files via the static middleware or a custom route.

### S3 driver

Uses Bun's native `S3Client` — works with AWS S3, Cloudflare R2, DigitalOcean Spaces, MinIO, and any S3-compatible service.

```bash
# .env for AWS S3
STORAGE_DRIVER=s3
S3_BUCKET=my-app
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=AKIA...
S3_SECRET_ACCESS_KEY=...

# .env for Cloudflare R2
STORAGE_DRIVER=s3
S3_BUCKET=my-r2-bucket
S3_REGION=auto
S3_ENDPOINT=https://account-id.r2.cloudflarestorage.com
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_BASE_URL=https://cdn.example.com

# .env for MinIO (local dev)
STORAGE_DRIVER=s3
S3_BUCKET=stravigor-test
S3_REGION=us-east-1
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY_ID=minioadmin
S3_SECRET_ACCESS_KEY=minioadmin
```

When `S3_BASE_URL` is set (e.g. a CDN), `Storage.url()` returns a direct URL. Otherwise it returns a presigned URL with configurable expiry:

```typescript
Storage.url('avatars/photo.jpg')          // presigned, 1h default
Storage.url('avatars/photo.jpg', 86400)   // presigned, 24h
```

### Ostra driver

Stores files on a [Stravigor Ostra](https://github.com/stravigor/ostra) server — a standalone object storage service with an HTTP API.

```bash
# .env
STORAGE_DRIVER=ostra
OSTRA_URL=http://localhost:9000
OSTRA_TOKEN=otk_...
OSTRA_BUCKET=my-bucket
```

`Storage.url()` returns a direct URL to the ostra server (`http://localhost:9000/buckets/my-bucket/path`). For public-read buckets this works without authentication. For private buckets, use the `OstraClient` to generate signed URLs (see below).

### Ostra client (advanced)

Beyond the `Storage` facade, you can use `OstraClient` directly for the full Ostra API — buckets, versions, multipart uploads, signed URLs, and tokens:

```typescript
import { OstraClient } from '@strav/kernel'

const ostra = new OstraClient({ url: 'http://localhost:9000', token: 'otk_...' })

// Bucket operations
await ostra.createBucket('photos', { visibility: 'public-read' })
const buckets = await ostra.listBuckets()

// Scoped bucket handle
const bucket = ostra.bucket('photos')
await bucket.info()
await bucket.update({ versioning: 'enabled' })
await bucket.destroy()

// Object operations
await bucket.put('avatars/me.png', file)
const blob = await bucket.get('avatars/me.png')
const meta = await bucket.head('avatars/me.png')
await bucket.delete('avatars/me.png')
const { objects } = await bucket.list({ prefix: 'avatars/', limit: 50 })
await bucket.deleteMany(['a.png', 'b.png'])
await bucket.copy('dest-key', { bucket: 'source-bucket', key: 'source-key' })

// Versions
const blob = await bucket.get('me.png', { versionId: 'ver_abc' })
await bucket.delete('me.png', { versionId: 'ver_abc' })
await bucket.delete('me.png', { allVersions: true })
const { versions } = await bucket.versions('me.png')

// Signed URLs
const { url, expires_at } = await bucket.signedUrl('me.png', 'GET', 3600)

// Multipart uploads
const upload = await bucket.multipart('videos/big.mp4', 'video/mp4')
await upload.part(1, chunk1)
await upload.part(2, chunk2)
await upload.complete()  // or upload.abort()

// Token management (requires root scope)
await ostra.createToken({ scope: 'read-write', buckets: ['photos'] })
const tokens = await ostra.listTokens()
await ostra.deleteToken('tok_abc')
```

You can also access the `OstraClient` from the driver when using the `Storage` facade:

```typescript
import { StorageManager, OstraDriver } from '@strav/kernel'

const driver = StorageManager.driver as OstraDriver
const { url } = await driver.client.bucket('my-bucket').signedUrl('private/doc.pdf', 'GET', 3600)
```

Errors from the ostra server throw `OstraError` with `code`, `message`, and `statusCode`:

```typescript
import { OstraError } from '@strav/kernel'

try {
  await bucket.get('missing.txt')
} catch (e) {
  if (e instanceof OstraError) {
    e.code       // 'OBJECT_NOT_FOUND'
    e.statusCode // 404
    e.message    // 'Object not found'
  }
}
```

## Bootstrap

### Using a service provider (recommended)

```typescript
import { StorageProvider } from '@strav/kernel'

app.use(new StorageProvider())
```

The `StorageProvider` registers `StorageManager` as a singleton. It depends on the `config` provider.

### Manual setup

```typescript
import { StorageManager } from '@strav/kernel'

app.singleton(StorageManager)
app.resolve(StorageManager)
```

## Controller example

```typescript
import { Storage, Upload, FileTooLargeError } from '@strav/kernel'

export default class ProfileController {
  async updateAvatar(ctx: Context) {
    const session = ctx.get<Session>('session')
    const user = ctx.get<User>('user')
    const { avatar } = await ctx.files('avatar')

    if (!avatar) {
      session.flash('error', 'No file selected.')
      return ctx.redirect('/profile')
    }

    try {
      // Delete old avatar if exists
      if (user.avatarPath) await Storage.delete(user.avatarPath)

      const { path } = await Upload.file(avatar)
        .maxSize('5mb')
        .types(['image/jpeg', 'image/png', 'image/webp'])
        .store('avatars')

      await BaseModel.db.sql`
        UPDATE "user_profile" SET "avatar_url" = ${path} WHERE "user_pid" = ${user.pid}
      `

      session.flash('success', 'Avatar updated.')
    } catch (e) {
      if (e instanceof FileTooLargeError) {
        session.flash('error', 'Image must be under 5MB.')
      } else {
        session.flash('error', 'Invalid file type.')
      }
    }

    return ctx.redirect('/profile')
  }
}
```
