/**
 * Page tree builder (spec §6.2). A single-level tree (one `/Pages` node) until
 * the page count exceeds 50, after which it is balanced into fan-out-of-8
 * intermediate nodes. Intermediate `/Pages` node dictionaries are written into
 * the {@link ObjectTable}; the caller builds the leaf `/Page` dictionaries
 * using the returned parent map.
 */

import type { IndirectRef, PdfObject } from '../objects/types.ts'
import { arr, dict, name, num } from '../objects/types.ts'
import type { ObjectTable } from './object_table.ts'

const FAN_OUT = 8
const SINGLE_LEVEL_MAX = 50

export interface PageTreeResult {
  /** The `/Pages` root reference (goes in the catalog). */
  rootRef: IndirectRef
  /** leaf object number → its immediate parent `/Pages` node reference. */
  parentOf: Map<number, IndirectRef>
}

function pagesNode(kids: IndirectRef[], count: number, parent: IndirectRef | null) {
  const entries: Record<string, PdfObject> = {
    Type: name('Pages'),
    Kids: arr([...kids]),
    Count: num(count),
  }
  if (parent) entries.Parent = parent
  return dict(entries)
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * @param leafRefs pre-allocated references for the leaf `/Page` objects, in
 *                  page order.
 */
export function buildPageTree(table: ObjectTable, leafRefs: IndirectRef[]): PageTreeResult {
  const parentOf = new Map<number, IndirectRef>()

  if (leafRefs.length <= SINGLE_LEVEL_MAX) {
    const rootRef = table.allocate()
    for (const leaf of leafRefs) parentOf.set(leaf.num, rootRef)
    table.set(rootRef, pagesNode(leafRefs, leafRefs.length, null))
    return { rootRef, parentOf }
  }

  // Multi-level: build intermediate nodes bottom-up, deferring each node's
  // dictionary until its own parent is known.
  const deferred = new Map<number, { ref: IndirectRef; kids: IndirectRef[]; count: number }>()
  let level: { ref: IndirectRef; count: number }[] = leafRefs.map(ref => ({ ref, count: 1 }))

  while (level.length > 1) {
    const next: { ref: IndirectRef; count: number }[] = []
    for (const group of chunk(level, FAN_OUT)) {
      const nodeRef = table.allocate()
      let count = 0
      for (const child of group) {
        parentOf.set(child.ref.num, nodeRef)
        count += child.count
      }
      deferred.set(nodeRef.num, { ref: nodeRef, kids: group.map(g => g.ref), count })
      next.push({ ref: nodeRef, count })
    }
    level = next
  }

  const rootRef = level[0]!.ref
  for (const { ref, kids, count } of deferred.values()) {
    table.set(ref, pagesNode(kids, count, parentOf.get(ref.num) ?? null))
  }
  return { rootRef, parentOf }
}
