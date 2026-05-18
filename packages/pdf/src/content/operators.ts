/**
 * PDF 1.7 content-stream operator names (spec §8.2). The builder emits these;
 * keeping them as named constants prevents typos and documents coverage.
 *
 * `BX`/`EX` (compatibility) and the marked-content operators are intentionally
 * absent — not generated in v1 (marked content arrives with tagged PDF, v1.1).
 */

export const OP = {
  // Graphics state
  save: 'q',
  restore: 'Q',
  cm: 'cm',
  lineWidth: 'w',
  lineCap: 'J',
  lineJoin: 'j',
  miterLimit: 'M',
  dash: 'd',
  renderingIntent: 'ri',
  flatness: 'i',
  extGState: 'gs',

  // Path construction
  moveTo: 'm',
  lineTo: 'l',
  curveTo: 'c',
  curveToV: 'v',
  curveToY: 'y',
  rect: 're',
  closePath: 'h',

  // Path painting
  stroke: 'S',
  closeStroke: 's',
  fill: 'f',
  fillEvenOdd: 'f*',
  fillStroke: 'B',
  fillStrokeEvenOdd: 'B*',
  closeFillStroke: 'b',
  closeFillStrokeEvenOdd: 'b*',
  endPath: 'n',

  // Clipping
  clip: 'W',
  clipEvenOdd: 'W*',

  // Color
  strokeColorSpace: 'CS',
  fillColorSpace: 'cs',
  strokeColor: 'SC',
  strokeColorN: 'SCN',
  fillColor: 'sc',
  fillColorN: 'scn',
  strokeGray: 'G',
  fillGray: 'g',
  strokeRGB: 'RG',
  fillRGB: 'rg',
  strokeCMYK: 'K',
  fillCMYK: 'k',

  // XObjects / shading
  xobject: 'Do',
  shading: 'sh',

  // Text (object scaffolding only in v1; full text in M4/M5)
  beginText: 'BT',
  endText: 'ET',
} as const

export type OperatorName = (typeof OP)[keyof typeof OP]
