/**
 * Public error taxonomy (spec §16.2).
 *
 * Every error thrown by the library is a subclass of {@link PdfGenError} and
 * carries a stable `code` string for programmatic handling. The taxonomy is
 * part of the API contract — codes do not change across minor versions.
 */

export type PdfGenErrorCode =
  | 'PDF_INVALID_NUMBER'
  | 'PDF_INVALID_STRING'
  | 'PDF_INVALID_NAME'
  | 'PDF_INVALID_OBJECT'
  | 'PDF_UNBALANCED_GRAPHICS_STATE'
  | 'PDF_PATH_NOT_CONSUMED'
  | 'PDF_NO_PATH'
  | 'PDF_INVALID_COLOR'
  | 'PDF_INVALID_PAGE'
  | 'PDF_DOCUMENT_FINALIZED'
  | 'PDF_CONFORMANCE'
  | 'PDF_UNSUPPORTED_FONT'
  | 'PDF_INVALID_IMAGE'
  | 'PDF_TEXT_STATE'
  | 'PDF_TEXT_ENCODING'
  | 'PDF_NO_FONT'
  | 'PDF_PARSE'
  | 'PDF_ENCRYPTED'
  | 'PDF_UNSUPPORTED_DECODE'

export class PdfGenError extends Error {
  readonly code: PdfGenErrorCode

  constructor(code: PdfGenErrorCode, message: string) {
    super(message)
    this.name = new.target.name
    this.code = code
    // Maintain a clean stack across the subclass chain.
    Object.setPrototypeOf(this, new.target.prototype)
  }
}

/** Thrown at `save()` when a conformance mode's requirements are violated. */
export class ConformanceError extends PdfGenError {
  readonly violations: string[]

  constructor(message: string, violations: string[] = []) {
    super('PDF_CONFORMANCE', message)
    this.violations = violations
  }
}

/** Thrown when a font cannot be used (e.g. Standard-14 under conformance). */
export class UnsupportedFontError extends PdfGenError {
  constructor(message: string) {
    super('PDF_UNSUPPORTED_FONT', message)
  }
}

/** Thrown when image bytes cannot be parsed or are an unsupported variant. */
export class InvalidImageError extends PdfGenError {
  constructor(message: string) {
    super('PDF_INVALID_IMAGE', message)
  }
}

/** Thrown when an existing PDF cannot be parsed (read side, M13). */
export class PdfParseError extends PdfGenError {
  constructor(message: string) {
    super('PDF_PARSE', message)
  }
}

/**
 * Thrown when a PDF is encrypted in a way M13 does not support: a non-empty
 * user password, or a non-standard / unsupported security handler.
 */
export class EncryptedPdfError extends PdfGenError {
  constructor(message: string) {
    super('PDF_ENCRYPTED', message)
  }
}
