# Transparency & patterns

Constant-alpha/blend-mode transparency (ExtGState), tiling patterns and
axial/radial shadings. Resources register automatically into the page
`/Resources` (`/ExtGState`, `/Pattern`, `/Shading`).

## Transparency (ExtGState)

`document.createExtGState({...})` (or the standalone `extGState`) builds an
extended graphics state; `content.setExtGState` selects it with the `gs`
operator. Wrap it in `save()`/`restore()` to scope it.

```typescript
const ghost = doc.createExtGState({
  strokeAlpha: 0.4,   // CA
  fillAlpha: 0.4,     // ca
  blendMode: 'Multiply', // BM — any of the 16 PDF blend modes
})

c.save().setExtGState(ghost)
  .setFillColor(rgb(1, 0, 0)).rect(0, 0, 80, 80).fill()
  .restore()
```

## Tiling patterns

`document.createTilingPattern({...})` repeats a cell across the area you fill.
The `draw` callback gets a content-stream builder scoped to the cell; anything
it uses (colors, images, fonts) is collected into the pattern's own
`/Resources`.

```typescript
const dots = doc.createTilingPattern({
  bbox: [0, 0, 12, 12],
  xStep: 12,
  yStep: 12,
  paintType: 'colored',          // or 'uncolored' (tinted by the caller)
  draw: (cell) => {
    cell.setFillColor(rgb(0.1, 0.4, 0.8)).rect(2, 2, 6, 6).fill()
  },
})

c.setFillPattern(dots)           // → /Pattern cs  /P1 scn
 .rect(0, 0, 200, 60)
 .fill()
```

`setStrokePattern` is the stroking equivalent. A colored pattern carries its
own color; an uncolored one is tinted by the current color.

## Shadings (gradients)

`createAxialShading` (type 2, linear) and `createRadialShading` (type 3)
produce a gradient. Two colors emit a Type-2 exponential function; three or
more emit a Type-3 stitching function. Stops are evenly spaced, or pass
`{ offset, color }` objects.

```typescript
const linear = doc.createAxialShading({
  from: [0, 0],
  to: [200, 0],
  colors: [rgb(1, 0.6, 0), rgb(0.6, 0, 0.7)],
  extend: [true, true],
})

const sun = doc.createRadialShading({
  from: { x: 50, y: 50, r: 0 },
  to: { x: 50, y: 50, r: 40 },
  colors: [rgb(1, 1, 1), rgb(1, 0.5, 0)],
})
```

Use a shading two ways:

```typescript
// 1. Paint over the current clip with the `sh` operator:
c.save().rect(0, 0, 200, 200).clip().endPath().shade(linear).restore()

// 2. As a fill/stroke pattern:
c.setFillPattern(doc.createShadingPattern(sun)).rect(10, 10, 80, 80).fill()
```

Shading stop colors must all be in the same device color space.

## Limits (v1)

- Shading **types 2 and 3** ship with helpers; types 1 and 4–7 are reachable
  by adding raw objects (spec §12.2 — operator-level support, minimal helpers).
- Tiling patterns are fully supported as **colored**; `'uncolored'` is
  accepted at the object level.
- PDF/X-4 restricts some blend modes in some contexts — that is validated at
  the conformance milestone (see [pdf.md › Status](pdf.md#status)).

## Determinism

ExtGState/pattern/shading objects are added in deterministic order and
resource names (`GS1`, `P1`, `Sh1`, …) assigned by first use, so identical
input yields byte-identical output.
