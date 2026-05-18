# Fonts & Text

Text is drawn inside a `text()` block on the content-stream builder. Two kinds
of font are available:

- **Standard-14** — the fonts every PDF viewer is required to have, referenced
  by name and never embedded (`PdfFont.standard`).
- **Embedded TrueType** — a `.ttf`/`.ttc` font fully embedded as a Type0 /
  CIDFontType2 with a ToUnicode CMap (`PdfFont.fromTrueType`).

Embedded TrueType fonts are **subsetted** to the glyphs you actually use.
OpenType/CFF (`.otf`) and complex-script shaping are on the roadmap.

```typescript
import { PdfFont } from '@strav/pdf'

page.content().text((t) => {
  t.setFont(PdfFont.standard('Helvetica'), 12)
   .moveTo(72, 720)
   .show('Hello, world.')
})
```

## The Standard-14 fonts

```typescript
PdfFont.standard('Helvetica')
PdfFont.standard('Helvetica-Bold')
PdfFont.standard('Helvetica-Oblique')
PdfFont.standard('Helvetica-BoldOblique')
PdfFont.standard('Times-Roman')
PdfFont.standard('Times-Bold')
PdfFont.standard('Times-Italic')
PdfFont.standard('Times-BoldItalic')
PdfFont.standard('Courier')
PdfFont.standard('Courier-Bold')
PdfFont.standard('Courier-Oblique')
PdfFont.standard('Courier-BoldOblique')
PdfFont.standard('Symbol')
PdfFont.standard('ZapfDingbats')
```

`PdfFont.standard(name)` returns a reusable `PdfFont`. Reusing the same
instance across a page deduplicates it to a single resource entry; the name
type is exported as `StandardFontName`.

```typescript
const font = PdfFont.standard('Times-Roman')
font.baseFont          // 'Times-Roman'
font.isStandard14      // true
font.widthOfText('Hello', 12)   // rendered width in points
```

## Embedded TrueType fonts

`PdfFont.fromTrueType(bytes)` embeds a TrueType (`glyf`) font from its raw
`.ttf`/`.ttc` bytes. The font is emitted as a composite **Type0 /
CIDFontType2** with **Identity-H** encoding and a **ToUnicode** CMap, so any
script the font covers renders and the text stays selectable and
copy/pasteable.

```typescript
import { PdfFont } from '@strav/pdf'
import { readFile } from 'node:fs/promises'

const inter = PdfFont.fromTrueType(await readFile('./fonts/Inter-Regular.ttf'))

page.content().text((t) =>
  t.setFont(inter, 14).moveTo(72, 720).show('Hello — Καλημέρα — Привет')
)
```

Options:

```typescript
PdfFont.fromTrueType(bytes, { faceIndex: 1 }) // pick a .ttc face (default 0)
PdfFont.fromTrueType(bytes, { subset: false }) // embed the whole font program
```

What is emitted, automatically: a `FontFile2` stream (Flate-compressed, with
`/Length1`), a `FontDescriptor` (flags, bbox, metrics derived from `head` /
`hhea` / `OS/2` / `post`), the descendant `CIDFontType2` with a `/W` width
array, and the `ToUnicode` CMap. Only the glyphs you actually draw are listed
in `/W` and `ToUnicode`.

### Subsetting

By default the embedded `FontFile2` is **subsetted** to the glyphs the document
uses (plus `.notdef` and the transitive components of composite glyphs), so a
large font costs only the outlines you actually draw — typically a 10–50×
reduction. Original glyph indices are preserved, so Identity-H codes, `/W`,
`ToUnicode` and `CIDToGIDMap` are unaffected.

A subsetted font's PostScript name carries the spec-mandated six-letter prefix,
e.g. `ABCDEF+Inter`. The tag is **deterministic** — derived from the glyph set,
not random — so identical input produces a byte-identical font. `cmap` and the
OpenType layout tables are passed through unchanged (not subsetted), so a very
large font's floor is the size of those tables. Pass `{ subset: false }` to
embed the whole program with an untagged name.

```typescript
const font = PdfFont.fromTrueType(ttfBytes)
font.isStandard14      // false
font.baseFont          // the font's PostScript name
font.widthOfText('Hi', 12)   // exact, from the font's hmtx table
```

Notes and current limits:

- **TrueType `glyf` only.** OpenType/CFF (`.otf`, `OTTO`) throws
  `UnsupportedFontError` — embed a `glyf` `.ttf`.
- Code points the font's `cmap` doesn't cover map to `.notdef` (glyph 0).
- No OpenType layout (ligatures, contextual shaping, GPOS kerning) and no
  complex-script shaping — text is drawn in the order given. Use `showRun`
  for manual kerning (see below).

## Text objects

`text(cb)` opens the block and hands the callback a text builder:

```typescript
page.content().text((t) => {
  t.setFont(PdfFont.standard('Helvetica-Bold'), 24)
  t.moveTo(40, 700)                 // absolute position
  t.show('Title')

  t.setFont(PdfFont.standard('Helvetica'), 12)
  t.setLeading(16)
  t.moveTo(40, 670)
  t.show('First line')
  t.newLineShow('Second line')      // T* then show, using the leading
})
```

### Positioning

| Method | Operator | Meaning |
|---|---|---|
| `moveTo(x, y)` | `1 0 0 1 x y Tm` | **Absolute** position. Successive calls position independently. |
| `setTextMatrix(a,b,c,d,e,f)` | `Tm` | Full text matrix — scale / rotate / skew. |
| `nextLine(tx, ty)` | `Td` | Move **relative** to the current line's start. |
| `newLine()` | `T*` | Next line using the current leading. |
| `setLeading(v)` | `TL` | Line leading (used by `newLine`/`newLineShow`). |

> Use `moveTo` for independent lines. `nextLine`/`Td` is *relative* to the
> previous line — repeating it with absolute coordinates walks off the page.

### Showing text

```typescript
t.show('simple string')                     // (…) Tj

t.showRun([                                  // [ … ] TJ
  { text: 'Wa' },
  { adjust: -120 },                          // kern: 1/1000 em, subtracted
  { text: 'ter' },
])

t.newLineShow('next line')                   // T* then Tj
```

### Text state

```typescript
t.setCharSpacing(v)    // Tc
t.setWordSpacing(v)    // Tw
t.setHorizScale(90)    // Tz — percent
t.setRise(3)           // Ts — superscript/subscript
t.setRenderMode(0)     // Tr — 0 fill, 1 stroke, 2 fill+stroke, 3 invisible, 4–7 clip
```

## Encoding

**Standard-14** text fonts use **WinAnsiEncoding**: ASCII and the Latin-1 upper
half map directly and the CP1252 0x80–0x9F band is supported (€, '', "", –, —,
…, ™, etc.). A character outside WinAnsi (e.g. CJK) throws `PDF_TEXT_ENCODING` —
encoding never silently substitutes; use an embedded font for non-WinAnsi
scripts. `Symbol` and `ZapfDingbats` use their own built-in encoding and have no
`/Encoding` entry; pass bytes already in that encoding.

**Embedded TrueType** fonts use **Identity-H**: each character is mapped through
the font's `cmap` to a glyph and written as a 2-byte code, so any code point
the font covers works (a `ToUnicode` CMap keeps the text extractable).

## Widths

`font.widthOfText(text, sizePt)` returns the rendered width in points.

- **Embedded TrueType:** exact, from the font's `hmtx` table.
- **Standard-14:** canonical Adobe Core-14 AFM metrics — exact for ASCII
  (32–126); the non-ASCII WinAnsi range uses a per-font approximation (refined
  in a later milestone). This affects only measurement: rendering is
  unaffected, since Standard-14 fonts carry no `/Widths` array.

## Guards

- `show()`/`showRun()` before `setFont()` → `PDF_NO_FONT`.
- Path or graphics-state operators inside a `text()` block → `PDF_TEXT_STATE`.
- Opening `text()` while a path is unconsumed → `PDF_PATH_NOT_CONSUMED`.

## Conformance

Standard-14 fonts are **referenced, never embedded**. PDF/A and PDF/X require
all fonts embedded, so using a Standard-14 font under any `conformance` mode
throws `UnsupportedFontError` at `save()` — explicitly, with no automatic
substitution.

Use `PdfFont.fromTrueType(...)` for the conformant path: embedded fonts (with
their ToUnicode CMap) are accepted under a conformance mode. Full PDF/A-2b and
PDF/X-4 validation lands with the conformance milestone.
