# Color management

Beyond the three device spaces, `@strav/pdf` supports ICC-managed, spot
(Separation), DeviceN and CIE color spaces, plus document **output intents**
for print/archival workflows. Every color — device or managed — is applied the
same way, with `setFillColor` / `setStrokeColor`.

```typescript
import { separation, iccBased, cmyk } from '@strav/pdf'

const pantone = separation('PANTONE 185 C', cmyk(0, 0.91, 0.76, 0))
page.content()
  .setFillColor(pantone.tint(0.6))   // 60% of the spot color
  .rect(20, 20, 100, 100)
  .fill()
```

Managed color spaces are registered automatically in the page
`/Resources /ColorSpace` and selected with `cs`/`scn` (fill) or `CS`/`SCN`
(stroke); device colors keep using the shortcut operators.

## Device color

`gray` / `rgb` / `cmyk` — components in `[0, 1]`, out of range throws
`PDF_INVALID_COLOR`. Preview-only conversions: `rgbToGray`, `cmykToRgb`,
`rgbToCmyk` (not color-accurate). See [content.md](content.md#color).

## ICC-based color

`iccBased(profileBytes)` embeds a raw ICC profile (`.icc`/`.icm`) as an
`[/ICCBased <stream>]` color space with the right `/N` and a device
`/Alternate`. Only the 128-byte header is parsed (data color space → component
count); **no color conversion is performed** — the profile is embedded opaquely
for the consumer (RIP/Acrobat).

```typescript
const srgb = iccBased(await readFile('./sRGB.icc'))
c.setFillColor(srgb.color(0.15, 0.55, 0.95))   // 3 components for an RGB profile
```

## Separation (spot color)

`separation(colorant, fullColor)` is a single spot ink. `fullColor` is what
it prints at 100% tint, in a device space (usually CMYK). The tint transform is
a **Type-2 (exponential) function** interpolating from no ink at tint 0 to
`fullColor` at tint 1.

```typescript
const spot = separation('PANTONE 877 C', cmyk(0, 0, 0, 0.35))
c.setFillColor(spot.tint(1))     // full strength
c.setFillColor(spot.tint(0.25)) // 25% tint
```

## DeviceN

`deviceN(names, alternate, postscript)` — N named colorants mapped to an
alternate device space by a **Type-4 PostScript** tint transform (multi-input).

```typescript
const duo = deviceN(['Black', 'Spot'], 'DeviceCMYK', '{ … }')
c.setFillColor(duo.color(0.8, 0.2))
```

## CIE-based

`calGray`, `calRGB`, `lab` — device-independent array color spaces with a
parameter dictionary (D50 white point by default).

```typescript
const l = lab({ range: [-128, 127, -128, 127] })
c.setFillColor(l.color(70, 20, -30))   // L*, a*, b*
```

## Output intents

`document.setOutputIntent({...})` embeds a destination ICC profile and adds it
to the catalog `/OutputIntents`. Required for PDF/X-4 (CMYK or Gray profile).

```typescript
doc.setOutputIntent({
  subtype: 'GTS_PDFX',                       // or 'GTS_PDFA1'
  outputConditionIdentifier: 'FOGRA39',
  registryName: 'http://www.color.org',
  destOutputProfile: await readFile('./CoatedFOGRA39.icc'),
})
```

The profile is parsed for its component count and embedded Flate-compressed.
Identifier fields are written as plain (PDFDocEncoding) strings so print
preflight tools can read them.

## Limits

- **No ICC color transforms.** Profiles are embedded as opaque blobs; the
  library never converts between color spaces with a CMM. Pre-convert
  externally if you need accurate device values.
- Image `iCCP` profiles are still rendered in their device space (an image
  ICCBased wrapper is a later refinement).
- Full PDF/X-4 / PDF/A validation lands with the conformance milestone — the
  color/output-intent structure is correct now, but `setConformance` does not
  yet enforce the full ruleset.

## Determinism

Function and profile objects are added in deterministic order and resource
names (`CS1`, `CS2`, …) assigned by first use, so identical input yields
byte-identical output (see [pdf.md › Determinism](pdf.md#determinism)).
