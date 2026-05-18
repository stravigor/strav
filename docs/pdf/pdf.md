# PDF Generation

Low-level, zero-dependency PDF **writer**. Produces conformant PDF 1.7 byte
streams from a programmatic API — it does not parse, render, or display PDFs.
No `@strav/*` dependency and no npm runtime dependency; only Node/Bun built-ins.

> **Scope.** This is the engine for higher-level document libraries. It draws
> exactly what you tell it to — layout, line breaking, and hyphenation are the
> caller's job. Implemented today: the object/serialization core, pages and
> content streams, device color, stream filters, the Standard-14 fonts, and
> embedded TrueType (subsetted) and OpenType/CFF fonts (spec milestones 1–7).
> Images, ICC color, transparency, and PDF/A · PDF/X conformance are on the
> roadmap (see
> [Status](#status)).

## Quick start

```typescript
import { PdfDocument, PdfFont, rgb, mm } from '@strav/pdf'

const doc = PdfDocument.create({ info: { title: 'Hello', author: 'Acme' } })

const page = doc.addPage({ size: { widthPt: mm(210), heightPt: mm(297) } })

page
  .content()
  .save()
  .setFillColor(rgb(0.1, 0.1, 0.4))
  .rect(mm(20), mm(240), mm(60), mm(30))
  .fill()
  .text((t) =>
    t.setFont(PdfFont.standard('Helvetica-Bold'), 24)
      .moveTo(mm(20), mm(210))
      .show('Hello, print world.')
  )
  .restore()

const bytes: Uint8Array = await doc.save()
await Bun.write('out.pdf', bytes)
```

`save()` returns the complete PDF as a `Uint8Array`. It is single-use — calling
it twice, or adding a page after it, throws.

## Document model

```typescript
const doc = PdfDocument.create({
  info: { title, author, subject, keywords, creator }, // all optional
  conformance: null,            // 'PDF/A-2b' | 'PDF/X-4' | null (see Status)
  creationDate: new Date(),     // fix this for deterministic output
  documentId: undefined,        // fix this for deterministic output
})

const page = doc.addPage({
  size: { widthPt: mm(210), heightPt: mm(297) },
  rotation: 0,                  // 0 | 90 | 180 | 270
})

await doc.save()                // Promise<Uint8Array>
```

A `Producer` of `@strav/pdf` and synced `CreationDate`/`ModDate` are written to
the Info dictionary automatically. The page tree is a single-level `/Pages`
node, automatically balanced into a fan-out-of-8 tree past 50 pages.

### Pages and boxes

```typescript
const page = doc.addPage({ size: { widthPt: 595, heightPt: 842 } })

page.index            // 0-based page number
page.size             // { widthPt, heightPt }
page.rotation         // 0 | 90 | 180 | 270

// All boxes take a Rect { x, y, w, h } in points (origin bottom-left).
page.setMediaBox({ x: 0, y: 0, w: 595, h: 842 })
page.setCropBox(/* … */)
page.setBleedBox(/* … */)      // for PDF/X-4 (enforced in a later milestone)
page.setTrimBox(/* … */)       // for PDF/X-4
page.setArtBox(/* … */)

page.content()                 // the content-stream builder — see content.md
```

If no MediaBox is set it defaults to the page size.

## Coordinates and units

The API is in **points** (1 pt = 1/72 inch), the PDF user-space unit, with the
origin at the **bottom-left**. Convert from physical units with the helpers:

```typescript
import { pt, inch, mm, cm } from '@strav/pdf'

mm(210)   // 595.27… pt   (A4 width)
cm(2.5)   // 70.86…  pt
inch(1)   // 72       pt
pt(12)    // 12       pt   (identity; for readability)
```

## Determinism

Identical input plus a fixed creation date and document ID produces
**byte-identical** output — useful for caching, content hashing, and golden
tests.

```typescript
const doc = PdfDocument.create({
  creationDate: new Date(0),
  documentId: '00112233445566778899aabbccddeeff', // 32 hex chars, or 16 bytes
})
// Two saves of the same document graph → Buffer.compare(a, b) === 0
```

Without a fixed `documentId`, the permanent ID is derived from the Info
dictionary and the per-save ID is random (spec-compliant `/ID` behaviour).

## Errors

Every thrown error is a subclass of `PdfGenError` and carries a stable `code`
string for programmatic handling — the taxonomy is part of the API contract.

```typescript
import {
  PdfGenError,
  ConformanceError,
  UnsupportedFontError,
  InvalidImageError,
} from '@strav/pdf'

try {
  await doc.save()
} catch (e) {
  if (e instanceof PdfGenError) console.error(e.code, e.message)
}
```

Common codes: `PDF_INVALID_NUMBER`, `PDF_INVALID_COLOR`,
`PDF_UNBALANCED_GRAPHICS_STATE`, `PDF_PATH_NOT_CONSUMED`, `PDF_NO_PATH`,
`PDF_TEXT_STATE`, `PDF_TEXT_ENCODING`, `PDF_NO_FONT`, `PDF_UNSUPPORTED_FONT`,
`PDF_DOCUMENT_FINALIZED`.

## Stream compression

Content streams and other large data are FlateDecoded automatically (zlib
level 9, deterministic). Data under 64 bytes and already-compressed data are
left raw. There is nothing to configure for typical use.

## Runtime

Node/Bun only — there is no browser build. `node:zlib` is used for
FlateDecode; `node:crypto` for the document ID. These built-ins are not
considered dependencies.

## Status

| Area | State |
|---|---|
| Object model, serialization, xref, trailer | ✅ available |
| Pages, content streams, graphics state | ✅ available — see [content.md](content.md) |
| Device color (Gray / RGB / CMYK) | ✅ available |
| Stream filters (Flate / ASCII85 / ASCIIHex) | ✅ available |
| Standard-14 fonts + text | ✅ available — see [fonts.md](fonts.md) |
| Embedded TrueType — subsetted, Type0/CIDFontType2 + ToUnicode | ✅ available — see [fonts.md](fonts.md) |
| Embedded OpenType/CFF — Type0/CIDFontType0 (whole) | ✅ available — see [fonts.md](fonts.md) |
| CFF subsetting, complex-script shaping | 🔜 roadmap |
| Images (JPEG/PNG), SMask | 🔜 roadmap |
| ICC color, Separation/DeviceN, output intents | 🔜 roadmap |
| Transparency, patterns, shadings | 🔜 roadmap |
| PDF/A-2b and PDF/X-4 conformance validation | 🔜 roadmap |

Setting `conformance` is accepted today, but full validation lands with the
conformance milestone. The one rule enforced now: a Standard-14 font used
under any conformance mode throws `UnsupportedFontError` at `save()`.

## See also

- [content.md](content.md) — the content-stream builder: paths, painting,
  graphics state, transforms, color.
- [fonts.md](fonts.md) — Standard-14 and embedded TrueType/OpenType fonts, text
  objects, and encoding.
