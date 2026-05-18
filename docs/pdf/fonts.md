# Fonts & Text

Text is drawn inside a `text()` block on the content-stream builder. Today the
library supports the **Standard-14** fonts — the fonts every PDF viewer is
required to have, referenced by name and never embedded. Embedded
TrueType/OpenType fonts, subsetting, and CJK are on the roadmap.

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

Text-drawing fonts use **WinAnsiEncoding**. ASCII and the Latin-1 upper half
map directly; the CP1252 0x80–0x9F band is supported (€, '', "", –, —, …, ™,
etc.). A character outside WinAnsi (e.g. CJK) throws `PDF_TEXT_ENCODING` —
encoding never silently substitutes. Embed a Unicode font (roadmap) for
non-WinAnsi scripts.

`Symbol` and `ZapfDingbats` use their own built-in encoding and have no
`/Encoding` entry; pass bytes already in that encoding.

## Widths

`font.widthOfText(text, sizePt)` returns the rendered width in points using the
canonical Adobe Core-14 AFM metrics. ASCII (32–126) is exact; the non-ASCII
WinAnsi range currently uses a per-font approximation (refined in a later
milestone). This affects only measurement — rendering is unaffected, because
Standard-14 fonts carry no `/Widths` array and the viewer supplies metrics.

## Guards

- `show()`/`showRun()` before `setFont()` → `PDF_NO_FONT`.
- Path or graphics-state operators inside a `text()` block → `PDF_TEXT_STATE`.
- Opening `text()` while a path is unconsumed → `PDF_PATH_NOT_CONSUMED`.

## Conformance

Standard-14 fonts are **referenced, never embedded**. PDF/A and PDF/X require
all fonts embedded, so using a Standard-14 font under any `conformance` mode
throws `UnsupportedFontError` at `save()` — explicitly, with no automatic
substitution. Embedded fonts (the conformant path) are on the roadmap.
