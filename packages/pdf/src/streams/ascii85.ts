/**
 * ASCII85Decode (spec §7.1). Available; not used by default. Adobe variant:
 * 4-byte groups → 5 chars offset by '!' (0x21); an all-zero group is 'z';
 * the stream ends with the `~>` EOD marker.
 */

export function ascii85Encode(data: Uint8Array): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < data.length; i += 4) {
    const len = Math.min(4, data.length - i)
    let word = 0
    for (let j = 0; j < 4; j++) {
      word = (word * 256 + (j < len ? data[i + j]! : 0)) >>> 0
    }
    if (len === 4 && word === 0) {
      out.push(0x7a) // 'z'
      continue
    }
    const group = [0, 0, 0, 0, 0]
    for (let k = 4; k >= 0; k--) {
      group[k] = word % 85
      word = Math.floor(word / 85)
    }
    for (let k = 0; k < len + 1; k++) out.push(group[k]! + 0x21)
  }
  out.push(0x7e, 0x3e) // ~>
  return Uint8Array.from(out)
}

export function ascii85Decode(data: Uint8Array): Uint8Array {
  const out: number[] = []
  const group: number[] = []
  for (let i = 0; i < data.length; i++) {
    const b = data[i]!
    if (b === 0x7e) break // ~ (start of ~>)
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0c) continue
    if (b === 0x7a) {
      // 'z' — only valid between groups
      if (group.length !== 0) throw new Error('Unexpected z in ASCII85 group')
      out.push(0, 0, 0, 0)
      continue
    }
    group.push(b - 0x21)
    if (group.length === 5) {
      let word = 0
      for (const g of group) word = word * 85 + g
      out.push((word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff)
      group.length = 0
    }
  }
  if (group.length === 1) throw new Error('Truncated ASCII85 group')
  if (group.length > 1) {
    const n = group.length
    while (group.length < 5) group.push(84)
    let word = 0
    for (const g of group) word = word * 85 + g
    const bytes = [(word >>> 24) & 0xff, (word >>> 16) & 0xff, (word >>> 8) & 0xff, word & 0xff]
    for (let k = 0; k < n - 1; k++) out.push(bytes[k]!)
  }
  return Uint8Array.from(out)
}
