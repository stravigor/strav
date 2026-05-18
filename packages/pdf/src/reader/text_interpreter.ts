/**
 * Content-stream text interpreter (spec §9.4). Executes the text-showing
 * subset of operators against a graphics/text state and emits positioned
 * glyph runs (device-space origin + advance + effective size). Non-text
 * operators are skipped; `BI…ID…EI` inline images are byte-skipped so their
 * binary payload never reaches the lexer.
 */

import { type PdfDictionary, isDict, isName, isStream } from '../objects/types.ts'
import { Lexer, latin1, type Token } from './lexer.ts'
import { buildCharMap, type CharMap } from './fonts.ts'
import type { Run } from './layout.ts'

/** 2×3 affine matrix [a b c d e f]; point (x,y) → (a x + c y + e, b x + d y + f). */
type Mat = [number, number, number, number, number, number]
const IDENT: Mat = [1, 0, 0, 1, 0, 0]

function mul(m: Mat, n: Mat): Mat {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ]
}

interface Doc {
  resolve(o: any): any
  getStreamData(s: any, num: number): Uint8Array
}

interface TextState {
  fontRes?: string
  fontSize: number
  charSpace: number
  wordSpace: number
  hScale: number // as a fraction (Tz / 100)
  leading: number
  rise: number
}

function freshTextState(): TextState {
  return { fontSize: 0, charSpace: 0, wordSpace: 0, hScale: 1, leading: 0, rise: 0 }
}

export function interpretText(
  content: Uint8Array,
  resources: PdfDictionary | undefined,
  doc: Doc,
): Run[] {
  const runs: Run[] = []
  const lex = new Lexer(content, 0)

  let ctm: Mat = IDENT
  const ctmStack: Mat[] = []
  let ts = freshTextState()
  let tm: Mat = IDENT
  let tlm: Mat = IDENT

  const fontCache = new Map<string, CharMap | undefined>()
  const fontDictCache = new Map<string, PdfDictionary | undefined>()
  const charMapFor = (res: string): CharMap | undefined => {
    if (fontCache.has(res)) return fontCache.get(res)
    let fd = fontDictCache.get(res)
    if (fd === undefined) {
      fd = lookupFont(resources, res, doc)
      fontDictCache.set(res, fd)
    }
    const cm = fd ? safe(() => buildCharMap(fd!, doc)) : undefined
    fontCache.set(res, cm)
    return cm
  }

  const operands: any[] = []
  const popNums = (k: number): number[] => {
    const v = operands.slice(-k).map((x) => (typeof x === 'number' ? x : 0))
    operands.length = Math.max(0, operands.length - k)
    return v
  }

  const showText = (bytes: Uint8Array, cm: CharMap | undefined): void => {
    if (!cm) return
    const trm0 = mul(mul([ts.fontSize * ts.hScale, 0, 0, ts.fontSize, 0, ts.rise], tm), ctm)
    const startX = trm0[4]
    const y = trm0[5]
    const scaleX = Math.hypot(ctm[0], ctm[1]) || 1
    const scaleY = Math.hypot(ctm[2], ctm[3]) || 1
    const fsDevice = ts.fontSize * scaleY
    const spaceDevice = (cm.spaceWidth / 1000) * ts.fontSize * ts.hScale * scaleX

    let text = ''
    for (const g of cm.decode(bytes)) {
      text += g.unicode
      const w0 = g.width1000 / 1000
      const isSpaceByte = g.code === 0x20
      const tx =
        (w0 * ts.fontSize + ts.charSpace + (isSpaceByte ? ts.wordSpace : 0)) * ts.hScale
      tm = mul([1, 0, 0, 1, tx, 0], tm)
    }
    const endX = mul(mul([ts.fontSize * ts.hScale, 0, 0, ts.fontSize, 0, ts.rise], tm), ctm)[4]
    runs.push({ text, x: startX, endX, y, fs: fsDevice || ts.fontSize || 1, spaceW: spaceDevice || 1 })
  }

  const showArray = (arr: any[], cm: CharMap | undefined): void => {
    if (!cm) return
    for (const el of arr) {
      if (el instanceof Uint8Array) {
        showText(el, cm)
      } else if (typeof el === 'number') {
        // TJ adjustment: positive moves left (spec §9.4.3).
        const tx = (-el / 1000) * ts.fontSize * ts.hScale
        tm = mul([1, 0, 0, 1, tx, 0], tm)
        // Synthesize a space for kerning-only word gaps.
        if (-el > 200 && runs.length) {
          const last = runs[runs.length - 1]!
          if (!last.text.endsWith(' ')) last.text += ' '
        }
      }
    }
  }

  for (;;) {
    const t = lex.next()
    if (t.type === 'eof') break

    if (t.type === 'num') {
      operands.push(t.value)
      continue
    }
    if (t.type === 'str') {
      operands.push(t.value)
      continue
    }
    if (t.type === 'name') {
      operands.push({ name: t.value })
      continue
    }
    if (t.type === 'delim') {
      if (t.value === '[') {
        operands.push(readArray(lex))
      } else if (t.value === '<<') {
        skipDict(lex)
        operands.push({})
      }
      continue
    }

    // Operator (keyword)
    const op = t.value
    switch (op) {
      case 'q':
        ctmStack.push(ctm)
        break
      case 'Q':
        ctm = ctmStack.pop() ?? ctm
        break
      case 'cm': {
        const [a, b, c, d, e, f] = popNums(6)
        ctm = mul([a!, b!, c!, d!, e!, f!], ctm)
        break
      }
      case 'BT':
        tm = IDENT
        tlm = IDENT
        break
      case 'ET':
        break
      case 'Td': {
        const [tx, ty] = popNums(2)
        tlm = mul([1, 0, 0, 1, tx!, ty!], tlm)
        tm = tlm
        break
      }
      case 'TD': {
        const [tx, ty] = popNums(2)
        ts.leading = -ty!
        tlm = mul([1, 0, 0, 1, tx!, ty!], tlm)
        tm = tlm
        break
      }
      case 'Tm': {
        const [a, b, c, d, e, f] = popNums(6)
        tlm = [a!, b!, c!, d!, e!, f!]
        tm = tlm
        break
      }
      case 'T*':
        tlm = mul([1, 0, 0, 1, 0, -ts.leading], tlm)
        tm = tlm
        break
      case 'Tc':
        ts.charSpace = popNums(1)[0]!
        break
      case 'Tw':
        ts.wordSpace = popNums(1)[0]!
        break
      case 'Tz':
        ts.hScale = popNums(1)[0]! / 100
        break
      case 'TL':
        ts.leading = popNums(1)[0]!
        break
      case 'Ts':
        ts.rise = popNums(1)[0]!
        break
      case 'Tf': {
        const size = popNums(1)[0]!
        const res = operands.pop()
        ts.fontSize = size
        ts.fontRes = res && typeof res === 'object' && 'name' in res ? res.name : undefined
        break
      }
      case 'Tj': {
        const s = operands.pop()
        if (s instanceof Uint8Array && ts.fontRes) showText(s, charMapFor(ts.fontRes))
        break
      }
      case 'TJ': {
        const a = operands.pop()
        if (Array.isArray(a) && ts.fontRes) showArray(a, charMapFor(ts.fontRes))
        break
      }
      case "'": {
        const s = operands.pop()
        tlm = mul([1, 0, 0, 1, 0, -ts.leading], tlm)
        tm = tlm
        if (s instanceof Uint8Array && ts.fontRes) showText(s, charMapFor(ts.fontRes))
        break
      }
      case '"': {
        const s = operands.pop()
        const [aw, ac] = popNums(2)
        ts.wordSpace = aw!
        ts.charSpace = ac!
        tlm = mul([1, 0, 0, 1, 0, -ts.leading], tlm)
        tm = tlm
        if (s instanceof Uint8Array && ts.fontRes) showText(s, charMapFor(ts.fontRes))
        break
      }
      case 'BI':
        skipInlineImage(lex)
        break
      default:
        // Unknown / non-text operator: discard its operands.
        operands.length = 0
    }
    if (op !== 'Tf') operands.length = 0
  }
  return runs
}

// ── Token helpers ──────────────────────────────────────────────────────────

function readArray(lex: Lexer): any[] {
  const out: any[] = []
  for (;;) {
    const t = lex.next()
    if (t.type === 'eof') break
    if (t.type === 'delim' && t.value === ']') break
    if (t.type === 'num') out.push(t.value)
    else if (t.type === 'str') out.push(t.value)
    else if (t.type === 'name') out.push({ name: t.value })
  }
  return out
}

function skipDict(lex: Lexer): void {
  let depth = 1
  for (;;) {
    const t = lex.next()
    if (t.type === 'eof') break
    if (t.type === 'delim' && t.value === '<<') depth++
    else if (t.type === 'delim' && t.value === '>>' && --depth === 0) break
  }
}

/** Skip `… ID <binary> EI` without tokenizing the binary payload. */
function skipInlineImage(lex: Lexer): void {
  // Consume the inline image dictionary up to the ID keyword.
  for (;;) {
    const t: Token = lex.next()
    if (t.type === 'eof') return
    if (t.type === 'kw' && t.value === 'ID') break
  }
  const b = lex.buf
  let p = lex.pos + 1 // one whitespace byte follows ID
  while (p + 1 < b.length) {
    if (
      b[p] === 0x45 && // 'E'
      b[p + 1] === 0x49 && // 'I'
      (p === 0 || isWsByte(b[p - 1]!)) &&
      (p + 2 >= b.length || isWsByte(b[p + 2]!))
    ) {
      lex.pos = p + 2
      return
    }
    p++
  }
  lex.pos = b.length
}

const isWsByte = (x: number) =>
  x === 0x00 || x === 0x09 || x === 0x0a || x === 0x0c || x === 0x0d || x === 0x20

function lookupFont(
  resources: PdfDictionary | undefined,
  res: string,
  doc: Doc,
): PdfDictionary | undefined {
  if (!resources) return undefined
  const fontsDict = doc.resolve(resources.entries.get('Font'))
  if (!fontsDict || !isDict(fontsDict)) return undefined
  const fd = doc.resolve(fontsDict.entries.get(res))
  return fd && isDict(fd) ? fd : undefined
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn()
  } catch {
    return undefined
  }
}

export { latin1, isName, isStream }
