/**
 * PDF number formatting (spec §5.1).
 *
 * - Integers serialized without a decimal point.
 * - Reals serialized with up to 6 decimal places; trailing zeros stripped;
 *   never in exponential notation.
 * - Infinity, NaN, and -0 throw at the boundary.
 *
 * The same formatter is used for object encoding AND content-stream operands
 * (spec §8.5) so numeric output is byte-identical everywhere.
 */

import { PdfGenError } from '../util/errors.ts'

const MAX_DECIMALS = 6

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) {
    throw new PdfGenError(
      'PDF_INVALID_NUMBER',
      `Cannot serialize non-finite number: ${value}`
    )
  }
  // Reject negative zero explicitly: Object.is distinguishes -0 from 0.
  if (Object.is(value, -0)) {
    throw new PdfGenError('PDF_INVALID_NUMBER', 'Cannot serialize negative zero')
  }

  if (Number.isInteger(value)) {
    return String(value)
  }

  // toFixed avoids exponential notation for the magnitudes PDF uses.
  let s = value.toFixed(MAX_DECIMALS)

  // Strip trailing zeros, then a trailing decimal point if all decimals went.
  s = s.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')

  // Rounding at 6 dp can yield "-0" or "-0.000000" → "-0"; normalize.
  if (s === '-0') return '0'

  return s
}
