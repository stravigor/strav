/**
 * Layout heuristics: positioned glyph runs → readable plain text. Runs are
 * grouped into lines by baseline proximity; intra-line gaps become spaces
 * (proportional to the font's space width); inter-line drops become newlines,
 * with a blank line for paragraph-sized jumps. No column/table reconstruction.
 */

export interface Run {
  text: string
  /** Device-space X of the run's first glyph origin. */
  x: number
  /** Device-space X just past the run's last glyph. */
  endX: number
  /** Device-space baseline Y. */
  y: number
  /** Effective device font size. */
  fs: number
  /** Device-space width of the space glyph. */
  spaceW: number
}

// Tunable thresholds (fractions of the space-glyph width / font size).
const SAME_LINE = 0.3 // |Δy| < SAME_LINE·fs ⇒ same line
const GLUE = 0.2 // gap < GLUE·spaceW ⇒ no separator
const WIDE = 2.5 // gap ≥ WIDE·spaceW ⇒ multiple spaces
const MAX_GAP_SPACES = 8
const PARA = 1.6 // line drop > PARA·fs ⇒ blank line

export function runsToText(runs: Run[], normalize = true): string {
  const items = runs.filter((r) => r.text.length > 0)
  if (items.length === 0) return ''

  items.sort((a, b) => (b.y - a.y) || (a.x - b.x))

  // Group into lines by baseline proximity.
  const lines: Run[][] = []
  let cur: Run[] = []
  let lineY = items[0]!.y
  let lineFs = items[0]!.fs
  for (const r of items) {
    if (cur.length && Math.abs(r.y - lineY) > SAME_LINE * Math.max(lineFs, r.fs)) {
      lines.push(cur)
      cur = []
    }
    if (cur.length === 0) {
      lineY = r.y
      lineFs = r.fs
    }
    cur.push(r)
  }
  if (cur.length) lines.push(cur)

  let out = ''
  let prevY: number | null = null
  let prevFs = lineFs
  for (const line of lines) {
    line.sort((a, b) => a.x - b.x)
    const y = line[0]!.y
    const fs = Math.max(...line.map((r) => r.fs))

    if (prevY !== null) {
      out += '\n'
      if (prevY - y > PARA * Math.max(fs, prevFs)) out += '\n'
    }

    let lineText = ''
    let prev: Run | null = null
    for (const r of line) {
      if (prev) {
        const gap = r.x - prev.endX
        const sw = prev.spaceW || r.spaceW || fs * 0.25
        if (gap >= WIDE * sw) {
          lineText += ' '.repeat(Math.min(MAX_GAP_SPACES, Math.round(gap / sw)))
        } else if (gap >= GLUE * sw) {
          lineText += ' '
        }
      }
      lineText += r.text
      prev = r
    }
    out += lineText
    prevY = y
    prevFs = fs
  }

  return normalize ? normalizeWhitespace(out) : out
}

function normalizeWhitespace(s: string): string {
  const lines = s.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').replace(/[ \t]+$/g, ''))
  // Collapse 3+ blank lines to a single blank line; trim leading/trailing.
  const collapsed: string[] = []
  let blanks = 0
  for (const l of lines) {
    if (l.trim() === '') {
      blanks++
      if (blanks <= 1) collapsed.push('')
    } else {
      blanks = 0
      collapsed.push(l)
    }
  }
  while (collapsed.length && collapsed[0] === '') collapsed.shift()
  while (collapsed.length && collapsed[collapsed.length - 1] === '') collapsed.pop()
  return collapsed.join('\n')
}
