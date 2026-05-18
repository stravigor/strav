/**
 * ToUnicode CMap writer (spec §10.6). Maps each used CID/GID back to its
 * Unicode code point(s) so text is searchable and copy/pasteable (mandatory
 * for PDF/A). `bfrange` is used for consecutive runs, `bfchar` otherwise.
 */

function hex4(n: number): string {
  return n.toString(16).toUpperCase().padStart(4, '0')
}

/** UTF-16BE hex for one code point (surrogate pair when astral). */
function utf16beHex(cp: number): string {
  if (cp <= 0xffff) return hex4(cp)
  const v = cp - 0x10000
  return hex4(0xd800 + (v >> 10)) + hex4(0xdc00 + (v & 0x3ff))
}

const HEADER =
  '/CIDInit /ProcSet findresource begin\n' +
  '12 dict begin\n' +
  'begincmap\n' +
  '/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n' +
  '/CMapName /Adobe-Identity-UCS def\n' +
  '/CMapType 2 def\n' +
  '1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n'

const FOOTER = 'endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n'

/**
 * Build the ToUnicode CMap stream content from a `gid → code point(s)` map.
 * Single-code-point entries that form consecutive GID→cp runs collapse into
 * `bfrange`; everything else (and multi-cp entries) uses `bfchar`.
 */
export function buildToUnicode(map: Map<number, number[]>): string {
  const gids = [...map.keys()].sort((a, b) => a - b)

  const ranges: { start: number; end: number; cp: number }[] = []
  const chars: { gid: number; cps: number[] }[] = []

  for (let i = 0; i < gids.length; ) {
    const gid = gids[i]!
    const cps = map.get(gid)!
    if (cps.length === 1) {
      let j = i
      for (;;) {
        const nextGid = gids[j + 1]
        if (nextGid === undefined || nextGid !== gids[j]! + 1) break
        const cur = map.get(gids[j]!)!
        const nxt = map.get(nextGid)!
        if (cur.length !== 1 || nxt.length !== 1 || nxt[0]! !== cur[0]! + 1) break
        j++
      }
      if (j > i) {
        ranges.push({ start: gid, end: gids[j]!, cp: cps[0]! })
        i = j + 1
        continue
      }
    }
    chars.push({ gid, cps })
    i++
  }

  let body = ''
  for (let k = 0; k < chars.length; k += 100) {
    const slice = chars.slice(k, k + 100)
    body += `${slice.length} beginbfchar\n`
    for (const { gid, cps } of slice) {
      body += `<${hex4(gid)}> <${cps.map(utf16beHex).join('')}>\n`
    }
    body += 'endbfchar\n'
  }
  for (let k = 0; k < ranges.length; k += 100) {
    const slice = ranges.slice(k, k + 100)
    body += `${slice.length} beginbfrange\n`
    for (const { start, end, cp } of slice) {
      body += `<${hex4(start)}> <${hex4(end)}> <${utf16beHex(cp)}>\n`
    }
    body += 'endbfrange\n'
  }

  return HEADER + body + FOOTER
}
