/**
 * XMP metadata packet (spec §14.2). The authoritative metadata in PDF 1.7+
 * and required for PDF/A-2b and PDF/X-4. Emitted as an **uncompressed**
 * `/Metadata` stream (PDF/A forensic-readability requirement); the document
 * Info dictionary carries the same values.
 *
 * `bfrange`-free, deterministic: with a fixed creation date the bytes are
 * byte-identical across runs (the xpacket id is a fixed constant).
 */

import { utf8 } from '../util/ascii.ts'
import { name } from '../objects/types.ts'
import type { PdfStream } from '../objects/types.ts'
import { makeStream } from '../streams/stream.ts'
import type { DocumentInfo } from '../document/types.ts'
import type { ConformanceLevel } from '../document/types.ts'

const XPACKET_ID = 'W5M0MpCehiHzreSzNTczkc9d'

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** ISO 8601 UTC, e.g. `2026-05-18T09:30:00+00:00`. */
function isoDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  return (
    `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+00:00`
  )
}

export interface XmpOptions {
  info: DocumentInfo
  creationDate: Date
  producer: string
  conformance: ConformanceLevel
}

export function buildXmpPacket(o: XmpOptions): string {
  const date = isoDate(o.creationDate)
  const lines: string[] = []
  const ns = [
    'xmlns:dc="http://purl.org/dc/elements/1.1/"',
    'xmlns:xmp="http://ns.adobe.com/xap/1.0/"',
    'xmlns:pdf="http://ns.adobe.com/pdf/1.3/"',
  ]
  if (o.conformance === 'PDF/A-2b') ns.push('xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"')
  if (o.conformance === 'PDF/X-4') ns.push('xmlns:pdfxid="http://www.npes.org/pdfx/ns/id/"')

  if (o.info.title) {
    lines.push(
      `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${esc(o.info.title)}</rdf:li></rdf:Alt></dc:title>`
    )
  }
  if (o.info.author) {
    lines.push(
      `<dc:creator><rdf:Seq><rdf:li>${esc(o.info.author)}</rdf:li></rdf:Seq></dc:creator>`
    )
  }
  if (o.info.subject) {
    lines.push(
      `<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${esc(o.info.subject)}</rdf:li></rdf:Alt></dc:description>`
    )
  }
  if (o.info.keywords) {
    const bag = o.info.keywords
      .split(/[,;]\s*/)
      .filter(Boolean)
      .map(k => `<rdf:li>${esc(k)}</rdf:li>`)
      .join('')
    lines.push(`<dc:subject><rdf:Bag>${bag}</rdf:Bag></dc:subject>`)
    lines.push(`<pdf:Keywords>${esc(o.info.keywords)}</pdf:Keywords>`)
  }
  lines.push('<dc:format>application/pdf</dc:format>')
  lines.push(`<xmp:CreateDate>${date}</xmp:CreateDate>`)
  lines.push(`<xmp:ModifyDate>${date}</xmp:ModifyDate>`)
  lines.push(`<xmp:MetadataDate>${date}</xmp:MetadataDate>`)
  if (o.info.creator) lines.push(`<xmp:CreatorTool>${esc(o.info.creator)}</xmp:CreatorTool>`)
  lines.push(`<pdf:Producer>${esc(o.producer)}</pdf:Producer>`)
  if (o.conformance === 'PDF/A-2b') {
    lines.push('<pdfaid:part>2</pdfaid:part>')
    lines.push('<pdfaid:conformance>B</pdfaid:conformance>')
  }
  if (o.conformance === 'PDF/X-4') {
    lines.push('<pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>')
  }

  return (
    `<?xpacket begin="﻿" id="${XPACKET_ID}"?>\n` +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    `<rdf:Description rdf:about="" ${ns.join(' ')}>\n` +
    lines.map(l => '  ' + l).join('\n') +
    '\n</rdf:Description>\n</rdf:RDF>\n</x:xmpmeta>\n' +
    '<?xpacket end="w"?>'
  )
}

/** The `/Metadata` stream object — uncompressed, no filters (PDF/A). */
export function buildXmpStream(o: XmpOptions): PdfStream {
  return makeStream(utf8(buildXmpPacket(o)), {
    filter: 'none',
    extra: { Type: name('Metadata'), Subtype: name('XML') },
  })
}
