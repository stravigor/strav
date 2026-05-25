import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { ExternalServiceError } from '@strav/kernel'
import { RichMenuClient } from '../src/rich_menu/rich_menu_client.ts'
import { gridRichMenu } from '../src/rich_menu/grid.ts'
import { RICH_MENU_LIMITS, RICH_MENU_SIZE_LARGE } from '../src/rich_menu/types.ts'
import type { CreateRichMenuRequest } from '../src/rich_menu/types.ts'
import { calls, installFetch, resetCalls, restoreFetch } from './_fetch_mock.ts'

const config = {
  channelAccessToken: 'CAT',
  baseUrl: 'https://api.line.test',
  dataBaseUrl: 'https://data.line.test',
}

const validRequest = (): CreateRichMenuRequest => ({
  size: RICH_MENU_SIZE_LARGE,
  selected: true,
  name: 'main',
  chatBarText: 'Menu',
  areas: [
    {
      bounds: { x: 0, y: 0, width: 2500, height: 1686 },
      action: { type: 'postback', data: 'action=hi' },
    },
  ],
})

beforeEach(() => {
  resetCalls()
})

afterEach(() => {
  restoreFetch()
})

describe('RichMenuClient.create', () => {
  test('posts the rich menu and returns the ID', async () => {
    installFetch(() => Response.json({ richMenuId: 'RM1' }))
    const c = new RichMenuClient(config)

    const id = await c.create(validRequest())

    expect(id).toBe('RM1')
    expect(calls[0]!.url).toBe('https://api.line.test/v2/bot/richmenu')
    expect(calls[0]!.headers.authorization).toBe('Bearer CAT')
  })

  test('rejects oversized chatBarText', async () => {
    installFetch(() => Response.json({ richMenuId: 'RM1' }))
    const c = new RichMenuClient(config)
    const req = validRequest()
    req.chatBarText = 'x'.repeat(RICH_MENU_LIMITS.CHAT_BAR_TEXT_MAX + 1)
    await expect(c.create(req)).rejects.toThrow(ExternalServiceError)
  })

  test('rejects areas that fall outside the canvas', async () => {
    installFetch(() => Response.json({ richMenuId: 'RM1' }))
    const c = new RichMenuClient(config)
    const req = validRequest()
    req.areas[0]!.bounds.width = 99_999
    await expect(c.create(req)).rejects.toThrow('outside')
  })
})

describe('RichMenuClient.uploadImage', () => {
  test('POSTs the binary to the data API host with the right content type', async () => {
    installFetch(() => new Response('', { status: 200 }))
    const c = new RichMenuClient(config)
    const png = new Uint8Array([137, 80, 78, 71])

    await c.uploadImage('RM1', png, 'image/png')

    expect(calls[0]!.url).toBe('https://data.line.test/v2/bot/richmenu/RM1/content')
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.headers['content-type']).toBe('image/png')
  })

  test('rejects images over the 1MB ceiling', async () => {
    installFetch(() => new Response('', { status: 200 }))
    const c = new RichMenuClient(config)
    const oversized = new Uint8Array(RICH_MENU_LIMITS.IMAGE_BYTES + 1)
    await expect(c.uploadImage('RM1', oversized, 'image/png')).rejects.toThrow(
      ExternalServiceError
    )
  })
})

describe('RichMenuClient default + link helpers', () => {
  test('setDefault POSTs to /v2/bot/user/all/richmenu/{id}', async () => {
    installFetch(() => Response.json({}))
    const c = new RichMenuClient(config)
    await c.setDefault('RM1')
    expect(calls[0]!.url).toBe('https://api.line.test/v2/bot/user/all/richmenu/RM1')
    expect(calls[0]!.method).toBe('POST')
  })

  test('getDefault returns null on 404', async () => {
    installFetch(() => new Response('', { status: 404 }))
    const c = new RichMenuClient(config)
    expect(await c.getDefault()).toBeNull()
  })

  test('linkToUser POSTs to /v2/bot/user/{userId}/richmenu/{id}', async () => {
    installFetch(() => Response.json({}))
    const c = new RichMenuClient(config)
    await c.linkToUser('U1', 'RM1')
    expect(calls[0]!.url).toBe('https://api.line.test/v2/bot/user/U1/richmenu/RM1')
  })

  test('bulkLink sends the userIds + richMenuId payload', async () => {
    installFetch(() => Response.json({}))
    const c = new RichMenuClient(config)
    await c.bulkLink(['U1', 'U2'], 'RM1')
    expect(calls[0]!.body).toEqual({ richMenuId: 'RM1', userIds: ['U1', 'U2'] })
  })
})

describe('gridRichMenu', () => {
  test('produces a uniform grid with row-major actions', () => {
    const req = gridRichMenu({
      name: 'main',
      chatBarText: 'Menu',
      rows: 2,
      cols: 3,
      actions: [
        { type: 'postback', data: 'a=1' },
        { type: 'postback', data: 'a=2' },
        { type: 'postback', data: 'a=3' },
        { type: 'postback', data: 'a=4' },
        { type: 'postback', data: 'a=5' },
        { type: 'postback', data: 'a=6' },
      ],
    })
    expect(req.areas).toHaveLength(6)
    // first row cell sizes match 2500/3 × 1686/2
    expect(req.areas[0]!.bounds.width).toBe(Math.floor(2500 / 3))
    expect(req.areas[0]!.bounds.height).toBe(Math.floor(1686 / 2))
    // top-left cell starts at origin
    expect(req.areas[0]!.bounds).toMatchObject({ x: 0, y: 0 })
    // bottom-right cell is at (2 * cellWidth, 1 * cellHeight)
    expect(req.areas[5]!.bounds.x).toBe(2 * Math.floor(2500 / 3))
    expect(req.areas[5]!.bounds.y).toBe(1 * Math.floor(1686 / 2))
  })

  test('throws when the action count does not match the grid size', () => {
    expect(() =>
      gridRichMenu({
        name: 'main',
        chatBarText: 'Menu',
        rows: 2,
        cols: 3,
        actions: [{ type: 'postback', data: 'a=1' }],
      })
    ).toThrow('expected 6 actions')
  })
})
