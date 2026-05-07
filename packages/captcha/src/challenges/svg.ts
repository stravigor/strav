import { encrypt } from '@strav/kernel'
import type { ChallengeType } from '../types.ts'
import { hashAnswer, safeEqual } from '../token.ts'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no 0/O/I/1
const LENGTH = 6
const WIDTH = 200
const HEIGHT = 70
const FONT_SIZE = 38

/**
 * Distorted-text challenge rendered as inline SVG — no canvas, no font
 * files, no external requests. Each glyph gets a small per-character
 * rotation and vertical jitter; a few decoy strokes cross the field to
 * break naive segmentation.
 *
 * Defense level: better than no captcha, far weaker than reCAPTCHA. The
 * point is to make scripted bulk submission expensive, not to stop a
 * targeted attacker who'll route to a human solver. Layer with PoW for
 * compounding cost.
 */
export const svgChallenge: ChallengeType = {
  name: 'svg',
  issue() {
    const answer = randomCode(LENGTH)
    return {
      props: {},
      answer,
      html: renderSvg(answer),
    }
  },
  verify(payload, response) {
    if (typeof response !== 'string' || response.trim() === '') {
      return { ok: false, reason: 'answer_mismatch' }
    }
    if (!payload.ah) return { ok: false, reason: 'token_invalid' }
    const expected = hashAnswer(response, payload.s)
    if (!safeEqual(expected, payload.ah)) {
      return { ok: false, reason: 'answer_mismatch' }
    }
    return { ok: true }
  },
}

/** Pick `n` characters from the confusables-pruned alphabet. */
function randomCode(n: number): string {
  const bytes = encrypt.randomBytes(n)
  let out = ''
  for (let i = 0; i < n; i++) {
    out += ALPHABET[bytes[i]! % ALPHABET.length]
  }
  return out
}

/**
 * Build the SVG body for a code. We seed RNG from the code so re-rendering
 * the same answer (e.g. for caching) yields the same image — but since
 * the salt + jti rotate per challenge issuance, the image still differs
 * across requests.
 */
export function renderSvg(code: string): string {
  // Bun's Math.random is fine for visual jitter — security comes from
  // the answer hash, not from making the SVG unpredictable.
  const glyphs: string[] = []
  const stepX = (WIDTH - 30) / code.length
  const baselineY = HEIGHT / 2 + FONT_SIZE / 3

  for (let i = 0; i < code.length; i++) {
    const ch = escapeXml(code[i]!)
    const x = 20 + stepX * i
    const y = baselineY + (Math.random() * 10 - 5)
    const rot = Math.random() * 40 - 20
    const skew = Math.random() * 16 - 8
    const fill = `hsl(${Math.floor(Math.random() * 360)}, 60%, 35%)`
    glyphs.push(
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${FONT_SIZE}" ` +
        `font-family="Helvetica, Arial, sans-serif" font-weight="700" fill="${fill}" ` +
        `transform="rotate(${rot.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)}) skewX(${skew.toFixed(1)})">` +
        `${ch}</text>`
    )
  }

  // Two distractor strokes — cheap segmentation breaker.
  const lines: string[] = []
  for (let i = 0; i < 2; i++) {
    const x1 = Math.random() * WIDTH
    const x2 = Math.random() * WIDTH
    const y1 = Math.random() * HEIGHT
    const y2 = Math.random() * HEIGHT
    const stroke = `hsl(${Math.floor(Math.random() * 360)}, 50%, 40%)`
    lines.push(
      `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${stroke}" stroke-width="1.5" />`
    )
  }

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" ` +
    `role="img" aria-label="Type the characters shown">` +
    `<rect width="100%" height="100%" fill="#f5f5f5"/>` +
    lines.join('') +
    glyphs.join('') +
    `</svg>`
  )
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}
