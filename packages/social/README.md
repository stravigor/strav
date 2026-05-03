# @strav/social

OAuth social authentication for the [Strav](https://www.npmjs.com/package/@strav/core) framework. Sign in with Google, GitHub, Discord, Facebook, and LinkedIn using a fluent, driver-based API.

## Install

```bash
bun add @strav/social
bun strav install social
```

Requires `@strav/core` as a peer dependency.

## Setup

```ts
import { SocialProvider } from '@strav/social'

app.use(new SocialProvider())
```

## Usage

```ts
import { social } from '@strav/social'

// Redirect to provider
r.get('/auth/github', ctx => {
  return social.driver('github').redirect(ctx)
})

// Handle callback
r.get('/auth/github/callback', async ctx => {
  const githubUser = await social.driver('github').user(ctx)

  // githubUser.id, .name, .email, .avatar, .nickname, .token
  let user = await User.findBy('email', githubUser.email)
  if (!user) {
    user = await User.create({ name: githubUser.name, email: githubUser.email })
  }

  await social.findOrCreate('github', githubUser, user)
  // authenticate session...
})
```

## Providers

- **Google** — OpenID Connect with Workspace domain restriction
- **GitHub** — User profile with verified email fallback
- **Discord** — Profile with computed avatar URLs
- **Facebook** — Graph API v21.0
- **LinkedIn** — OpenID Connect userinfo

## Fluent API

```ts
social.driver('github').scopes(['repo', 'gist']).redirect(ctx)
social.driver('google').with({ hd: 'example.com' }).redirect(ctx)
const user = await social.driver('google').userFromToken(accessToken)
```

## Custom Providers

```ts
import { AbstractProvider, social } from '@strav/social'

class SpotifyProvider extends AbstractProvider { /* ... */ }
social.extend('spotify', config => new SpotifyProvider(config))
```

## Documentation

See the full [Social guide](../../guides/social.md).

## License

MIT
