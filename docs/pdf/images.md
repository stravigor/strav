# Images

Embed JPEG and PNG images as PDF image XObjects and place them with
`content.drawImage`.

```typescript
import { PdfImage, mm } from '@strav/pdf'
import { readFile } from 'node:fs/promises'

const photo = PdfImage.fromJpeg(await readFile('./photo.jpg'))
const logo = PdfImage.fromPng(await readFile('./logo.png'))

page.content()
  .drawImage(photo, { x: mm(20), y: mm(200), width: mm(80), height: mm(60) })
  .drawImage(logo, { x: mm(20), y: mm(170), width: mm(40), height: mm(20) })
```

`PdfImage` exposes the source pixel dimensions:

```typescript
photo.width   // pixels
photo.height  // pixels — independent of the drawn size
```

The drawn `width`/`height` are points and only set the placement rectangle
(the CTM scale); the embedded pixel data is unchanged. To preserve aspect
ratio, size the rectangle from `width`/`height` yourself.

## JPEG

`PdfImage.fromJpeg(bytes)` embeds the JPEG **verbatim** with `/DCTDecode` —
the bytes are never re-encoded, so there is no quality loss and embedding is
fast. Only the marker segments are parsed:

- Dimensions, component count and bit depth come from the Start-Of-Frame
  marker. 8-bit Gray (1), RGB/YCbCr (3) and CMYK/YCCK (4) are supported.
- 12-bit JPEGs and files with no SOF throw `InvalidImageError`.
- A 4-component JPEG with an Adobe APP14 marker (the Photoshop CMYK
  convention) stores inverted samples, so a `/Decode [1 0 1 0 1 0 1 0]` is
  added automatically.

Color space follows the component count (`DeviceGray` / `DeviceRGB` /
`DeviceCMYK`).

## PNG

PDF has no PNG filter, so `PdfImage.fromPng(bytes)` decodes the PNG (inflate
IDAT, undo the line filters) and re-emits the raw samples with `/FlateDecode`
(no PDF predictor in v1).

- Color types: grayscale (0), RGB (2), indexed (3 → an `/Indexed` color space
  over `DeviceRGB` with the PLTE palette), gray+alpha (4) and RGBA (6).
- Bit depths 1/2/4/8 for gray/indexed, 8 for the rest. **16-bit and
  interlaced PNGs are rejected** (`InvalidImageError`) — downsample/
  de-interlace first.
- **Transparency** becomes a separate soft mask: an alpha channel (color
  type 4/6) or per-palette `tRNS` is split into an 8-bit `/SMask` image, so
  it blends correctly over whatever is behind it. A `tRNS` color key on
  gray/RGB images becomes a `/Mask` color-key array instead.

## Limits (v1)

- An embedded `iCCP` ICC profile is currently ignored — the image uses its
  device color space (`DeviceRGB`/`DeviceGray`). ICC-based color for images
  arrives with ICC support (see [pdf.md › Status](pdf.md#status)).
- JBIG2 / JPEG 2000 / CCITT-fax filters are out of scope.

## Determinism

Image output is deterministic: JPEG bytes are copied verbatim, PNG samples
are re-deflated at a fixed level, and resource names (`Im1`, `Im2`, …) are
assigned in first-use order — so identical input yields byte-identical PDFs
(see [pdf.md › Determinism](pdf.md#determinism)).
