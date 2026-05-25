import type { LineAction } from '../types.ts'
import {
  RICH_MENU_SIZE_LARGE,
  type CreateRichMenuRequest,
  type RichMenuArea,
  type RichMenuSize,
} from './types.ts'

/**
 * Build a uniform grid Rich Menu (rows × cols) over the standard 2500×1686
 * image size. Each cell carries a single LineAction. Cell index is row-major
 * (left-to-right, top-to-bottom).
 *
 * Matches the standard 6-cell (3 cols × 2 rows) layout the brief calls for
 * (New Post · Approvals · Connected Channels · Insights · Help · Settings).
 *
 * @example
 *   gridRichMenu({
 *     name: 'Main menu',
 *     chatBarText: 'Menu',
 *     rows: 2,
 *     cols: 3,
 *     actions: [
 *       postbackAction('action=new_post'),
 *       postbackAction('action=approvals'),
 *       postbackAction('action=channels'),
 *       postbackAction('action=insights'),
 *       postbackAction('action=help'),
 *       postbackAction('action=settings'),
 *     ],
 *   })
 */
export function gridRichMenu(opts: {
  name: string
  chatBarText: string
  rows: number
  cols: number
  actions: LineAction[]
  size?: RichMenuSize
  selected?: boolean
}): CreateRichMenuRequest {
  const size = opts.size ?? RICH_MENU_SIZE_LARGE
  const totalCells = opts.rows * opts.cols
  if (opts.actions.length !== totalCells) {
    throw new Error(
      `gridRichMenu: expected ${totalCells} actions for a ${opts.rows}×${opts.cols} grid, got ${opts.actions.length}`
    )
  }

  const cellWidth = Math.floor(size.width / opts.cols)
  const cellHeight = Math.floor(size.height / opts.rows)
  const areas: RichMenuArea[] = []

  for (let row = 0; row < opts.rows; row++) {
    for (let col = 0; col < opts.cols; col++) {
      const index = row * opts.cols + col
      const action = opts.actions[index]
      if (!action) continue
      areas.push({
        bounds: {
          x: col * cellWidth,
          y: row * cellHeight,
          width: cellWidth,
          height: cellHeight,
        },
        action,
      })
    }
  }

  return {
    size,
    selected: opts.selected ?? true,
    name: opts.name,
    chatBarText: opts.chatBarText,
    areas,
  }
}
