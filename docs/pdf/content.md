# Content Streams

The content-stream builder describes the visual contents of a page: paths,
fills, strokes, clipping, transforms, color, and text. It is fluent and
chainable, and its byte output is deterministic (operator order matches call
order; numbers use one shared serializer).

Get a builder with `page.content()`. It is append-only — every call adds
operators; there is no undo.

```typescript
import { rgb, gray, mm } from '@strav/pdf'

page
  .content()
  .save()
  .setStrokeColor(gray(0))
  .setLineWidth(1.5)
  .moveTo(mm(20), mm(20))
  .lineTo(mm(190), mm(20))
  .stroke()
  .restore()
```

## Graphics state stack

`save()` pushes the current graphics state; `restore()` pops it — they map to
the PDF `q`/`Q` operators. They must balance: an unmatched `restore()` throws
immediately, and unmatched `save()` calls are caught at `save()`-time on the
document with `PDF_UNBALANCED_GRAPHICS_STATE`.

```typescript
c.save()                       // q
 .setFillColor(rgb(1, 0, 0))
 .rect(0, 0, 100, 50).fill()
 .restore()                    // Q — fill color reverts here
```

State tracked across save/restore: CTM, stroke/fill color, line width, cap,
join, miter limit, and dash pattern.

## Transforms

```typescript
c.translate(mm(20), mm(20))            // 1 0 0 1 tx ty cm
 .scale(2, 2)                          // 2 0 0 2 0 0 cm
 .transform([a, b, c, d, e, f])        // arbitrary matrix concat (cm)
```

Transforms concatenate onto the current transformation matrix, so wrap them in
`save()`/`restore()` to scope their effect.

## Paths

Path **construction** operators open a path; a **painting** or **clipping**
operator consumes it. Starting a new path, a `save`/`restore`, or a text block
while a path is still open throws `PDF_PATH_NOT_CONSUMED` — silent path loss is
a classic hand-written-PDF bug, so the builder refuses it.

```typescript
// Construction
c.moveTo(x, y)
 .lineTo(x, y)
 .curveTo(x1, y1, x2, y2, x3, y3)      // cubic Bézier
 .rect(x, y, w, h)
 .closePath()

// Painting (each consumes the current path)
c.stroke()            // S
c.closeStroke()       // s
c.fill()              // f
c.fillEvenOdd()       // f*
c.fillStroke()        // B
c.closeFillStroke()   // b
c.endPath()           // n  — no paint (e.g. after a clip)
```

Painting with no open path throws `PDF_NO_PATH`.

### Clipping

`clip()` / `clipEvenOdd()` mark the current path as the clip path; the next
painting/`endPath()` operator applies it.

```typescript
c.rect(mm(20), mm(20), mm(100), mm(100))
 .clip()
 .endPath()                    // clip is now active for subsequent drawing
// … draw clipped content …
```

## Color

Three device color spaces. Components are in `[0, 1]`; out-of-range values
throw `PDF_INVALID_COLOR`.

```typescript
import { gray, rgb, cmyk } from '@strav/pdf'

c.setFillColor(gray(0))                  // DeviceGray
c.setStrokeColor(rgb(0.9, 0.1, 0.1))     // DeviceRGB
c.setFillColor(cmyk(0, 0, 0, 1))         // DeviceCMYK
```

Preview-only conversions are available (not color-accurate — use a real CMM
for production color):

```typescript
import { rgbToGray, cmykToRgb, rgbToCmyk } from '@strav/pdf'
```

## Text

Text lives in a `text()` block (`BT … ET`). The block always closes, even if
the callback throws, so the stream can never be left unbalanced. Path and
graphics-state operators are rejected inside it (`PDF_TEXT_STATE`).

```typescript
import { PdfFont } from '@strav/pdf'

c.text((t) => {
  t.setFont(PdfFont.standard('Helvetica'), 12)
   .moveTo(72, 720)             // absolute position (Tm)
   .show('Hello, world.')
})
```

See [fonts.md](fonts.md) for the full text API (fonts, `showRun` kerning,
line/leading control, encoding).

## Determinism

Content-stream bytes are stable: operator order follows call order, numbers go
through the same serializer used everywhere (integers with no decimal point;
reals to ≤6 dp, trailing zeros stripped, never exponential), and there are no
timestamps. See [pdf.md › Determinism](pdf.md#determinism).
