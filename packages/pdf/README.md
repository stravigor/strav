# @strav/pdf

Low-level, **zero-dependency** PDF generation (the *write* side) plus
layout-aware text extraction (the *read* side) for the Strav ecosystem.
Produces conformant PDF 1.7 byte streams and extracts plain text from existing
PDFs — it does not render or display PDFs. No `@strav/*` dependency and no npm
runtime dependency; only Node/Bun built-ins.

## Install

```bash
bun add @strav/pdf
```

## Quick start

```typescript
import { PdfDocument, PdfFont, rgb, mm } from '@strav/pdf'

const doc = PdfDocument.create({ info: { title: 'Hello', author: 'Acme' } })
const page = doc.addPage({ size: { widthPt: mm(210), heightPt: mm(297) } })

page.content()
  .save()
  .setFillColor(rgb(0.1, 0.1, 0.4))
  .rect(mm(20), mm(240), mm(60), mm(30)).fill()
  .text((t) =>
    t.setFont(PdfFont.standard('Helvetica-Bold'), 24)
      .moveTo(mm(20), mm(210))
      .show('Hello, print world.'),
  )
  .restore()

await Bun.write('out.pdf', await doc.save())
```

## Streaming output

`save()` buffers and returns a `Uint8Array`. For large documents or HTTP
responses, stream straight to a Node `Writable` instead — nothing is buffered:

```typescript
import { createWriteStream } from 'node:fs'

await doc.saveToStream(createWriteStream('out.pdf'))
```

`saveToStream` resolves once the stream has flushed; it rejects on a stream
error or a build/conformance error, exactly like `save()`.

## Text extraction (read side)

```typescript
import { extractText } from '@strav/pdf'

const { pages, text, info } = await extractText(await Bun.file('doc.pdf').bytes())
console.log(info.pageCount, pages[0].text)
```

Layout-aware plain text per page (heuristic spacing/line breaks), `/ToUnicode`
and encoding-based glyph decoding, classic + xref-stream + object-stream
parsing with broken-xref recovery, and empty-password decryption (RC4,
AES-128, AES-256). See [`docs/pdf/extraction.md`](../../docs/pdf/extraction.md)
— including the `@strav/rag` ingestion snippet.

## What's supported

Object model & serialization, pages, the full content-stream operator set,
device + ICC/Separation/DeviceN/CIE color, FlateDecode/ASCII85/ASCIIHex
filters, Standard-14 and embedded (subsetted) TrueType + OpenType/CFF fonts
with ToUnicode, JPEG/PNG images with alpha, transparency (ExtGState) and
tiling/shading patterns, XMP metadata, and PDF/A-2b / PDF/X-4 conformance
validation. Output is byte-deterministic with a fixed creation date and id.

On the read side: classic/xref-stream/object-stream parsing, layout-aware text
extraction, and empty-password decryption. Browser builds, write-side
encryption, signatures, forms, OCR, and PDF rendering remain out of scope.

## Documentation

Full guides live in [`docs/pdf`](../../docs/pdf/pdf.md): the content builder,
fonts, images, color, transparency/patterns, conformance, and
[text extraction](../../docs/pdf/extraction.md).

## Examples

Runnable under Bun (`packages/pdf/examples/`):

```bash
bun packages/pdf/examples/basic_page.ts
bun packages/pdf/examples/multi_font.ts
bun packages/pdf/examples/print_ready_pdfx4.ts <font.ttf> <cmyk.icc>
```

## License

MIT.
