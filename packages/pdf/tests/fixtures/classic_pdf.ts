/**
 * Test-only minimal classic-xref PDF assembler. Lets reader tests hand-craft
 * documents (inline images, cyclic page trees, encryption, missing fonts)
 * that the write side intentionally cannot produce.
 */

const enc = (s: string) => new TextEncoder().encode(s)

export function cat(parts: (string | Uint8Array)[]): Uint8Array {
  const arrs = parts.map((p) => (typeof p === 'string' ? enc(p) : p))
  const len = arrs.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(len)
  let o = 0
  for (const p of arrs) {
    out.set(p, o)
    o += p.length
  }
  return out
}

export interface RawObject {
  num: number
  /** Everything between `N 0 obj` and `endobj` (string or raw bytes). */
  body: string | Uint8Array
}

export function buildClassicPdf(
  objects: RawObject[],
  trailerExtra: Record<string, string>,
): Uint8Array {
  const parts: (string | Uint8Array)[] = ['%PDF-1.4\n%\xe2\xe3\xcf\xd3\n']
  let len = (parts[0] as string).length
  const offsets = new Map<number, number>()
  const maxNum = Math.max(...objects.map((o) => o.num))

  for (const o of objects) {
    offsets.set(o.num, len)
    const head = `${o.num} 0 obj\n`
    parts.push(head)
    parts.push(o.body)
    parts.push('\nendobj\n')
    len +=
      head.length +
      (typeof o.body === 'string' ? enc(o.body).length : o.body.length) +
      '\nendobj\n'.length
  }

  const xrefStart = len
  const size = maxNum + 1
  let xref = `xref\n0 ${size}\n0000000000 65535 f \n`
  for (let n = 1; n < size; n++) {
    const off = offsets.get(n) ?? 0
    xref += `${String(off).padStart(10, '0')} 00000 n \n`
  }
  const trailerEntries = Object.entries({ Size: String(size), ...trailerExtra })
    .map(([k, v]) => `/${k} ${v}`)
    .join(' ')
  const trailer = `trailer\n<<${trailerEntries}>>\nstartxref\n${xrefStart}\n%%EOF`
  return cat([...parts, xref, trailer])
}
