# Rich Menu

Persistent tap-grid that sits below the chat input. Each cell maps to a LINE [action](https://developers.line.biz/en/reference/messaging-api/#action-objects) — postback, message, URI, or one of the camera/location shortcuts. Used as the always-on navigation for your LINE Official Account.

## When to use

- Always-visible primary navigation ("New post", "Approvals", "Settings"…).
- Per-user customisation — link a specific menu to a user so different segments see different layouts.
- Switching menus on a postback (e.g. "advanced mode" toggles to a denser grid).

For one-off interactive prompts (approvals, replies to a specific message), use [Flex Messages](./flex.md) with `quickReply` instead — Rich Menus are persistent and shared across the whole OA.

## Quick start

```typescript
import { LineManager, gridRichMenu, postbackAction } from '@strav/line'

const richMenu = LineManager.richMenu

// 1. Build the menu (3 columns × 2 rows = 6 cells)
const request = gridRichMenu({
  name: 'Main menu — Thai',
  chatBarText: 'เมนู',
  rows: 2,
  cols: 3,
  actions: [
    postbackAction('action=new_post', { label: 'New post' }),
    postbackAction('action=approvals', { label: 'Approvals' }),
    postbackAction('action=channels', { label: 'Channels' }),
    postbackAction('action=insights', { label: 'Insights' }),
    postbackAction('action=help', { label: 'Help' }),
    postbackAction('action=settings', { label: 'Settings' }),
  ],
})

// 2. Create on LINE and upload the image
const id = await richMenu.create(request)
const png = await Bun.file('./rich-menu-2500x1686.png').bytes()
await richMenu.uploadImage(id, png, 'image/png')

// 3. Make it the default for every friend
await richMenu.setDefault(id)
```

## Anatomy

A Rich Menu has three pieces:

1. **Metadata** — `name` (internal label), `chatBarText` (what users see on the chat bar), `size`, `selected` (whether it's open by default), and an `areas[]` array mapping pixel bounds to actions.
2. **Image** — a single PNG or JPEG painted as the background. Pixel-perfect coordinates in `areas[]` must line up with whatever you draw.
3. **Assignment** — `setDefault`, `linkToUser`, or `bulkLink` decides who sees the menu.

### Sizes

LINE accepts two canonical sizes:

```typescript
import { RICH_MENU_SIZE_LARGE, RICH_MENU_SIZE_COMPACT } from '@strav/line'

RICH_MENU_SIZE_LARGE    // { width: 2500, height: 1686 }
RICH_MENU_SIZE_COMPACT  // { width: 2500, height: 843 }
```

Custom dimensions in the documented ranges (width 800–2500, height 250–1686) are also accepted but uncommon. The 6-cell 3×2 grid the [design brief](../../specs) calls for fits `RICH_MENU_SIZE_LARGE`.

### Limits

```typescript
import { RICH_MENU_LIMITS } from '@strav/line'

RICH_MENU_LIMITS.IMAGE_BYTES          // 1_048_576  (1 MiB)
RICH_MENU_LIMITS.NAME_MAX             // 300
RICH_MENU_LIMITS.CHAT_BAR_TEXT_MAX    // 14
```

`RichMenuClient.create` validates `name`, `chatBarText`, and area bounds before sending. `uploadImage` enforces the byte ceiling.

## API

```typescript
const rm = LineManager.richMenu
```

### `create(request) → richMenuId`

Submit the metadata. Returns the LINE-assigned ID — keep it around to upload the image and link users.

```typescript
const id = await rm.create({
  size: RICH_MENU_SIZE_LARGE,
  selected: true,
  name: 'Main menu',
  chatBarText: 'Menu',
  areas: [
    { bounds: { x: 0,    y: 0,   width: 833, height: 843 }, action: { type: 'postback', data: 'a=1' } },
    { bounds: { x: 833,  y: 0,   width: 833, height: 843 }, action: { type: 'postback', data: 'a=2' } },
    // ...
  ],
})
```

Throws `ExternalServiceError` if any area falls outside the canvas, `chatBarText` exceeds 14 chars, or `name` exceeds 300 chars.

### `uploadImage(id, bytes, contentType)`

Uploads the background image. Pass either a `Uint8Array` or a `Blob`. Content type must be `'image/png'` or `'image/jpeg'`. Max 1 MiB.

```typescript
await rm.uploadImage(id, await Bun.file('./menu.png').bytes(), 'image/png')
```

Image dimensions must match the `size` you declared on `create()` — LINE rejects mismatches at upload time.

### `get(id) → RichMenuResponse`

Fetch a single rich menu's metadata, including the assigned `richMenuId`.

### `list() → RichMenuResponse[]`

List every rich menu attached to this OA. Useful for housekeeping ("delete every menu that isn't the active default").

### `delete(id)`

Permanently remove the menu. Users linked to it revert to the default (or no menu if no default is set).

### `setDefault(id)` / `getDefault()` / `clearDefault()`

The default rich menu is shown to every friend who doesn't have a per-user override.

```typescript
await rm.setDefault(id)
const current = await rm.getDefault()   // string | null
await rm.clearDefault()                 // every friend sees no menu
```

`getDefault()` returns `null` when no default is set (LINE returns `404`).

### `linkToUser(userId, richMenuId)` / `unlinkFromUser(userId)`

Override the default for a single user.

```typescript
// On signup, give the user the "first run" menu
await rm.linkToUser(userId, firstRunMenuId)

// After onboarding, drop them back to the default
await rm.unlinkFromUser(userId)
```

### `bulkLink(userIds, richMenuId)` / `bulkUnlink(userIds)`

Batch versions — up to 500 user IDs per call per LINE's documented limit. Use these when migrating cohorts to a new menu after a feature launch.

## `gridRichMenu()` helper

Builds a uniform `rows × cols` grid over a standard image size and assigns one action per cell in row-major order. Saves you from typing pixel coordinates for symmetrical layouts.

```typescript
import { gridRichMenu, RICH_MENU_SIZE_LARGE } from '@strav/line'

gridRichMenu({
  name: 'Main menu',
  chatBarText: 'Menu',
  rows: 2,
  cols: 3,
  actions: [
    /* 6 actions, left-to-right, top-to-bottom */
  ],
  // Optional:
  size: RICH_MENU_SIZE_LARGE,   // default: large
  selected: true,               // default: true
})
```

The returned object is a ready-to-submit `CreateRichMenuRequest`. Cell width / height are `floor(size.width / cols)` and `floor(size.height / rows)`; the bottom row may leave a 1–2px sliver on canvas heights that don't divide evenly — irrelevant in practice because the corresponding sliver in the image is part of the same visual cell.

Throws if `actions.length !== rows * cols`.

## Switching menus on a postback

A common pattern: the default rich menu has a "Switch to expert mode" cell. Tap it, your bot receives a postback, you link the user to a different menu.

```typescript
router.post('/webhooks/line', async ctx => {
  const events = await parser.parse({ body, headers: ctx.request.headers })

  for (const event of events) {
    // (parser surfaces text + media; raw postback events live in event.raw)
    const raw = event.raw as { events: { type: string; postback?: { data: string }; source: { userId: string } }[] }
    for (const e of raw.events) {
      if (e.type === 'postback' && e.postback?.data === 'menu=expert') {
        await LineManager.richMenu.linkToUser(e.source.userId, expertMenuId)
      }
    }
  }

  return ctx.text('OK')
})
```

## Designing the image

A few practical tips that aren't in the LINE docs:

- Draw on a fully opaque background. Transparent PNGs render unpredictably on dark-mode clients.
- Leave visual padding between cells — users tap with thumbs and exact-edge hits feel wrong.
- Use `RICH_MENU_SIZE_LARGE` even if some cells are "empty" — the smaller compact size leaves no room for icon + label per cell.
- Keep the `chatBarText` short and Thai-language for Thai SME audiences. 14 chars is plenty for "เมนู" or "เริ่ม".
- Test on both iOS and Android — the rendered size differs.

## Recovering from a bad deploy

If you ship a broken menu and need to revert:

```typescript
// 1. Find every menu attached to the OA
const all = await rm.list()

// 2. Find the previous-good version (e.g. by `name`)
const previous = all.find(m => m.name === 'Main menu — v3')

// 3. Reinstate it
if (previous) {
  await rm.setDefault(previous.richMenuId)
}
```

Never `delete()` the previous menu in the same deploy that introduces a new one — keep at least one rollback target.
