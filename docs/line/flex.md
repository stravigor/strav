# Flex Messages

Strongly-typed AST and composable builders for LINE's [Flex Message](https://developers.line.biz/en/docs/messaging-api/using-flex-messages/) format. Build rich layouts (post preview cards, approval prompts, performance digests, error states) with TypeScript that catches structural mistakes at compile time and byte-size violations at validate time.

## When to reach for Flex

Plain text + media is fine for casual replies. Use Flex when the message has interactive controls (buttons, postback actions), a multi-section layout (header / hero / body / footer), language tabs, or anything that needs to look like a card rather than a chat bubble.

Reference layouts from the design brief that map to Flex:

| UX | Container | Notable components |
|---|---|---|
| Post preview with translation tabs | `carousel` (one bubble per language) | header text + hero image + body text + footer buttons |
| Approval confirmation | `bubble` | body text + footer with primary/secondary buttons |
| Weekly performance digest | `bubble` | hero metric + body breakdown + footer CTA |
| Channel-connection success | `bubble` (small/`kilo`) | hero icon + body text |
| Error / failure | `bubble` | body text + footer retry button |

## Quick start

```typescript
import {
  flexMessage,
  bubble,
  box,
  text,
  image,
  button,
  separator,
  postbackAction,
  uriAction,
  validateFlex,
} from '@strav/line'

const message = flexMessage(
  'Preview ready',
  bubble({
    hero: image('https://cdn.example.com/croissant.jpg', {
      size: 'full',
      aspectRatio: '20:13',
      aspectMode: 'cover',
    }),
    body: box('vertical', [
      text('New butter croissant', { weight: 'bold', size: 'xl' }),
      text('65 บาท', { color: '#888888', margin: 'sm' }),
      separator({ margin: 'lg' }),
      text('Will publish to Google, Instagram, Facebook', {
        wrap: true,
        margin: 'lg',
        size: 'sm',
      }),
    ]),
    footer: box('horizontal', [
      button(postbackAction('action=publish', { label: 'Publish all', displayText: 'Publishing…' }), {
        style: 'primary',
      }),
      button(uriAction('https://app.example.com/edit/42', 'Edit'), {
        style: 'secondary',
      }),
    ], { spacing: 'sm' }),
  })
)

validateFlex(message)        // throws FlexValidationError if it would fail at LINE
await LineManager.client.reply(replyToken, message)
```

## AST

Everything is a plain TypeScript object — no classes, no proxies, no runtime metadata. The builder functions are thin factories that inject the `type` discriminator and merge an optional overrides bag. Anything you build with the builders is also constructable by hand if you'd rather work with literals.

### Containers

A Flex message holds exactly one **container**:

- `FlexBubble` — single card. Top-level slots: `header`, `hero`, `body`, `footer`. Plus `size` (`nano` → `giga`), `direction`, and `styles` for per-slot background / separator colours.
- `FlexCarousel` — 1 to 12 bubbles displayed horizontally; user swipes between them. Common for "one bubble per language" or "one bubble per channel" layouts.

```typescript
bubble({ body: box('vertical', [text('Hi')]) })
carousel([bubble({ body: ... }), bubble({ body: ... })])
```

### Components

| Component | Builder | Purpose |
|---|---|---|
| `FlexBox` | `box(layout, contents, opts?)` | Flexbox container. Layout is `'horizontal'`, `'vertical'`, or `'baseline'`. The recursive building block. |
| `FlexText` | `text(value, opts?)` | Single text node. Supports `weight`, `color`, `align`, `wrap`, `maxLines`, `decoration`, `style`. |
| `FlexText` (rich) | `richText([span(...), span(...)], opts?)` | Mixed-formatting text via `FlexSpan` children. Use when one line needs multiple styles. |
| `FlexSpan` | `span(text, opts?)` | Inline run inside a `richText`. |
| `FlexImage` | `image(url, opts?)` | Image with `size`, `aspectRatio`, `aspectMode`, `align`, `gravity`. URL must be HTTPS. |
| `FlexIcon` | `icon(url, opts?)` | Small inline icon — only valid inside a `baseline`-layout box alongside text. |
| `FlexButton` | `button(action, opts?)` | Tap target. `style` is `'link'`, `'primary'`, or `'secondary'`. |
| `FlexSeparator` | `separator(opts?)` | Horizontal/vertical rule depending on parent box layout. |
| `FlexFiller` | `filler(flex?)` | Stretch-to-fill spacer; useful for pushing siblings to opposite ends of a box. |
| `FlexSpacer` | (no builder — deprecated) | Use `margin` on the next component instead. |
| `FlexVideo` | `video(url, previewUrl, altContent, opts?)` | Hero-slot video. `altContent` is shown on clients that can't play video. |

Layout properties (`flex`, `margin`, `padding*`, `position`, `offset*`, `align*`, `justifyContent`, etc.) are exposed on every component that supports them, and use LINE's keyword sizes (`'xs'` / `'sm'` / `'md'` / `'lg'` / `'xl'` / `'xxl'` / `'3xl'` / `'4xl'` / `'5xl'`) plus arbitrary `string` for custom dp / `%` values.

### Actions

The same `FlexAction` shape is reused for `button.action`, `box.action`, `image.action`, `text.action`, and `bubble.action`. Helpers:

```typescript
messageAction(text, label?)                          // user sends `text` back to the bot
postbackAction(data, { label?, displayText? })       // bot receives a postback event with `data`
uriAction(uri, label?)                               // opens a URL (browser or in-app)
```

You can also construct `datetimepicker`, `camera`, `cameraRoll`, and `location` actions directly as object literals — see the type alias `FlexAction` in `flex/types.ts`.

## Composition patterns

### Preview card (single bubble)

```typescript
import { flexMessage, bubble, box, text, image, button, separator, postbackAction } from '@strav/line'

flexMessage(
  'New post ready to publish',
  bubble({
    size: 'mega',
    hero: image(photoUrl, { size: 'full', aspectRatio: '4:3', aspectMode: 'cover' }),
    body: box('vertical', [
      text(title, { weight: 'bold', size: 'lg', wrap: true }),
      text(subtitle, { color: '#999', margin: 'sm', wrap: true }),
      separator({ margin: 'lg' }),
      box('horizontal', [
        text('Google', { size: 'sm', flex: 1 }),
        text('Instagram', { size: 'sm', flex: 1 }),
        text('Facebook', { size: 'sm', flex: 1 }),
      ], { margin: 'md' }),
    ]),
    footer: box('horizontal', [
      button(postbackAction(`publish:${postId}`, { label: 'Publish' }), { style: 'primary' }),
      button(postbackAction(`edit:${postId}`, { label: 'Edit' }), { style: 'secondary' }),
    ], { spacing: 'sm' }),
  })
)
```

### Carousel of language variants

```typescript
const languages = ['en', 'zh', 'ja']

flexMessage(
  'Preview ready in 3 languages',
  carousel(
    languages.map(lang =>
      bubble({
        size: 'kilo',
        body: box('vertical', [
          text(lang.toUpperCase(), { weight: 'bold', color: '#06c755' }),
          text(translations[lang], { wrap: true, margin: 'md' }),
        ]),
      })
    )
  )
)
```

### Inline styled text (price + strike-through)

```typescript
import { richText, span } from '@strav/line'

richText([
  span('120 บาท ', { decoration: 'line-through', color: '#999' }),
  span('99 บาท', { weight: 'bold', color: '#c00' }),
])
```

## Validation

`validateFlex(message)` enforces LINE's structural and byte limits and throws `FlexValidationError` on the first violation. Always call it before `push` / `reply` so the error surfaces in your code, not in a generic `400` from LINE.

```typescript
import { validateFlex, FlexValidationError } from '@strav/line'

try {
  validateFlex(message)
} catch (err) {
  if (err instanceof FlexValidationError) {
    log.warn('Flex message too large, falling back to text', err.message)
    await LineManager.client.reply(replyToken, { type: 'text', text: fallback })
    return
  }
  throw err
}

await LineManager.client.reply(replyToken, message)
```

What it checks:

| Check | Limit |
|---|---|
| `altText` non-empty | required by LINE |
| `altText` length | ≤ 400 characters |
| Bubble JSON size | ≤ 30,000 bytes |
| Carousel bubble count | between 1 and 12 |
| Every bubble inside a carousel | recursively validated |

Granular validators (`validateContainer`, `validateBubble`, `validateCarousel`) are also exported if you're constructing intermediate fragments.

What it does **not** check (LINE is the source of truth):

- Image URL reachability or HTTPS scheme
- Action data length (≤ 300 chars for postback `data`)
- Layout-specific constraints (e.g. `icon` only valid inside a `baseline` box)
- Sticker IDs

## Type-safe AST imports

Every node type is exported for cases where you want to write an explicit signature or compose without builders:

```typescript
import type {
  FlexContainer,
  FlexBubble,
  FlexCarousel,
  FlexComponent,
  FlexBox,
  FlexText,
  FlexImage,
  FlexButton,
  FlexAction,
  FlexSize,
} from '@strav/line'

function renderTenantHeader(tenant: { name: string; logo: string }): FlexBox {
  return {
    type: 'box',
    layout: 'horizontal',
    contents: [
      { type: 'image', url: tenant.logo, size: 'xs' },
      { type: 'text', text: tenant.name, weight: 'bold', margin: 'md' },
    ],
  }
}
```

## Cookbook: design-brief layouts

These map the brief's required Flex templates to concrete code stubs.

### Post preview with translation tabs

Use a `carousel` of `kilo`-size bubbles, one per language. Each bubble's footer carries the same `postbackAction('publish:<postId>')` so the user can approve from any language tab.

### Approval confirmation

Single `bubble` with `body` showing the post summary and `footer` carrying `Publish all` (primary) + `Cancel` (secondary). Add `direction: 'ltr'` explicitly so it renders consistently regardless of the user's locale.

### Channel connection success

Small `bubble` (`size: 'nano'` or `'micro'`) with a hero icon, a green ✓ in the body, and the channel name. No footer — this is a one-shot confirmation.

### Weekly performance digest

Single `bubble` with the headline metric (last week's view count, %change) in the body using `richText` for the +/- delta, followed by a `separator` and a per-post breakdown. Footer button: `View full digest` → `uriAction` to your LIFF analytics page.

### Error / failure card

Single `bubble`, body explains what failed in plain Thai, footer carries a `Retry` postback. Keep it short — error messages don't need a hero image.

## Hand-rolled JSON escape hatch

If you need a Flex feature that isn't in the AST (LINE adds them periodically), every node type allows arbitrary excess properties at the call site because TypeScript's excess-property checking is structural. Cast through `unknown` if needed:

```typescript
const bubble = {
  type: 'bubble',
  body: { type: 'box', layout: 'vertical', contents: [], background: { /* future prop */ } },
} as unknown as FlexBubble
```

This is rare — most apps live happily inside the AST.
