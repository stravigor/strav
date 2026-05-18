# PDF Text Extraction (read side)

`@strav/pdf` can also **read** an existing PDF and pull out its text. Same
zero-dependency footprint as the writer (only `node:zlib` and `node:crypto`).
This is milestone **M13** — primarily so `@strav/rag` can ingest PDF documents.

```typescript
import { extractText } from '@strav/pdf'

const bytes = await Bun.file('report.pdf').bytes()
const { pages, text, info } = await extractText(bytes)

console.log(info.pageCount, info.title)
console.log(pages[0].text) // first page's plain text
```

`extractText` returns `{ pages, text, info }`:

- `pages` — `{ number, text }[]`, 1-based, in document order.
- `text` — every page joined by the form-feed page separator (`'\f'`).
- `info` — `/Info` metadata + `pageCount` + `encrypted`.

## Options

```typescript
await extractText(bytes, {
  pages: { from: 2, to: 5 }, // or 3, or [1, 4, 9]; default all
  normalizeWhitespace: true, // collapse runs of spaces, trim — default true
  password: '',              // only the empty password is accepted (see below)
})
```

## Reusable handle

For repeated or lazy per-page access, open once:

```typescript
import { PdfReader } from '@strav/pdf'

const reader = await PdfReader.open(bytes)
reader.pageCount               // number
reader.info                    // PdfInfo
reader.pageText(1)             // string (1-based)
reader.extractText({ pages: 1 })
```

## How layout works

The extractor executes the text-showing operators (`Tj`, `TJ`, `'`, `"`)
against the page's graphics/text state, producing positioned glyph runs in
device space. Those runs are then turned into plain text with heuristics:

- runs are grouped into **lines** by baseline proximity;
- within a line, a horizontal gap wider than ~0.2× the font's space width
  becomes a space (a wide gap becomes several, capped at 8);
- a baseline drop emits a newline; a paragraph-sized drop emits a blank line;
- a large `TJ` kerning adjustment with no real space glyph synthesizes a space
  (so word-spaced-by-kerning PDFs still read correctly).

Character codes are mapped to Unicode with this precedence: `/ToUnicode` CMap →
simple-font `/Encoding` (base + `/Differences`, glyph name → Unicode) →
composite Identity/embedded-CMap → raw WinAnsi/Latin-1 fallback. A single
undecodable glyph never throws — it degrades to `U+FFFD` and extraction
continues.

## Encryption

Encrypted PDFs are supported **only with the empty user password** (the common
"protected but openable without a password" case): RC4 40/128-bit, AES-128
(V4/R4) and AES-256 (V5/R5–R6). A file that needs a real password, or uses a
non-standard security handler, throws `EncryptedPdfError`. Passing a non-empty
`password` also throws (validating real passwords is out of scope for v1).

## Non-goals (v1)

- **No OCR.** Scanned / image-only pages contain no text and yield none.
- **No layout reconstruction** — no columns, tables, or reading-order
  inference. Output is linear per line.
- **No annotation / AcroForm / XFA field values.**
- **No vertical writing mode** extraction (degrades to horizontal).
- Embedded-font-cmap-only glyphs **without** `/ToUnicode` resolve to `U+FFFD`
  (position/word count preserved).
- Non-empty / owner passwords and non-standard handlers are unsupported.

## Errors

Reader errors are `PdfGenError` subclasses with stable codes:

```typescript
import { PdfParseError, EncryptedPdfError } from '@strav/pdf'
```

- `PdfParseError` — `PDF_PARSE`: the bytes are not a recoverable PDF.
- `EncryptedPdfError` — `PDF_ENCRYPTED`: needs a password / unsupported handler.

Malformed cross-reference tables are recovered automatically by scanning the
file for object headers, so most truncated or hand-edited PDFs still extract.

## Using it with `@strav/rag`

`@strav/rag` is text-agnostic — it ingests strings. There is **no** dependency
between the packages; you wire them together at the call site:

```typescript
import { extractText } from '@strav/pdf'
import { rag } from '@strav/rag'

const { pages, info } = await extractText(await Bun.file('doc.pdf').bytes())

for (const p of pages) {
  await rag.ingest(p.text, {
    sourceId: `doc.pdf#p${p.number}`,
    metadata: { filename: 'doc.pdf', page: p.number, pages: info.pageCount },
  })
}
```

Per-page ingestion keeps the page number in metadata so retrieved chunks can
cite their source page; `sourceId` lets you `deleteBySource()` a document later.
