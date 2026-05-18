# Metadata & conformance

Every PDF carries document metadata; opting into a conformance mode adds
print/archival rules that are validated at `save()`.

## Metadata

Two synchronized sources are always written:

- The legacy **Info dictionary** (`/Title /Author /Subject /Keywords /Creator
  /Producer /CreationDate /ModDate`), populated from `info` on
  `PdfDocument.create({ info })`.
- An **XMP packet** as an uncompressed `/Metadata` stream on the catalog
  (`dc:`, `xmp:`, `pdf:` properties; `pdfaid:` / `pdfxid:` added under a
  conformance mode). XMP is uncompressed for forensic readability (a PDF/A
  requirement) and is byte-deterministic with a fixed creation date.

```typescript
const doc = PdfDocument.create({
  info: { title: 'Report', author: 'Acme', subject: '…', keywords: 'a, b' },
  creationDate: new Date(0),     // fixed → deterministic XMP/Info
})
```

XMP values are XML-escaped; keywords split on `,`/`;` into a `dc:subject` bag.

## Conformance

```typescript
const doc = PdfDocument.create({ conformance: 'PDF/X-4' })
// or, later:
doc.setConformance('PDF/A-2b')   // 'PDF/A-2b' | 'PDF/X-4' | null
```

Validation runs at `save()`. Violations are collected and thrown together as a
`ConformanceError` (its `.violations` is the full list); a Standard-14 font
used under any mode throws `UnsupportedFontError` first (fail-fast, before the
aggregate check). Validation happens before the document is finalized, so you
can catch, fix, and `save()` again.

```typescript
try {
  await doc.save()
} catch (e) {
  if (e instanceof ConformanceError) console.error(e.violations)
}
```

### PDF/X-4 — enforced

- An **OutputIntent** with a **CMYK or Gray** destination ICC profile
  (`doc.setOutputIntent({...})`, see [color.md](color.md)).
- Every page has a **TrimBox or ArtBox** (`page.setTrimBox(...)`); MediaBox
  alone is not enough.
- All fonts embedded & subsetted, `/ID` present, XMP `pdfxid:GTS_PDFXVersion`
  = `PDF/X-4` — all guaranteed by the library.

### PDF/A-2b — enforced

- An **OutputIntent** is required (the all-DeviceGray exception is *not*
  auto-detected — set one explicitly).
- All fonts embedded with a ToUnicode CMap (guaranteed; Standard-14 rejected),
  XMP `pdfaid:part` = 2 / `pdfaid:conformance` = B.

### Always true (so never checked)

The library never emits encryption, `LZWDecode`, JavaScript, external
references or file attachments, and always writes the `/ID` array — so those
prohibitions hold by construction.

## Limits

- PDF/A-2b's "all-DeviceGray, no OutputIntent" exception is not detected; an
  OutputIntent is always required under conformance.
- Validation is structural. Full **veraPDF** (PDF/A-2b) and **Acrobat
  preflight** (PDF/X-4) remain the authoritative external gates — run them on
  release candidates.

## Determinism

With a fixed `creationDate` (and `documentId`), the XMP packet, Info
dictionary and the whole file are byte-identical across runs — including under
a conformance mode. See [pdf.md › Determinism](pdf.md#determinism).
