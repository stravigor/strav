import { describe, test, expect } from 'bun:test'
import { Writable } from 'node:stream'
import { PdfDocument } from '../src/document/pdf_document.ts'
import { StreamSink } from '../src/output/stream_sink.ts'
import { PdfGenError, ConformanceError } from '../src/util/errors.ts'
import { expectValidPdf, deterministicOpts } from './helpers.ts'

/** A Writable that collects everything into one Buffer. */
function collector() {
  const chunks: Buffer[] = []
  const w = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk))
      cb()
    },
  })
  return { w, bytes: () => Buffer.concat(chunks) }
}

function buildDoc() {
  const doc = PdfDocument.create({ ...deterministicOpts, info: { title: 'Stream' } })
  const p = doc.addPage({ size: { widthPt: 300, heightPt: 400 } })
  p.content()
    .save()
    .setFillColor({ space: 'DeviceRGB', r: 0.2, g: 0.4, b: 0.8 })
    .rect(10, 10, 280, 380)
    .fill()
    .restore()
  return doc
}

describe('StreamSink (§3.3)', () => {
  test('streamed bytes are identical to the buffered save()', async () => {
    const buffered = await buildDoc().save()
    const { w, bytes } = collector()
    await buildDoc().saveToStream(w)
    expect(Buffer.compare(bytes(), Buffer.from(buffered))).toBe(0)
  })

  test('saveToStream produces a valid PDF', async () => {
    const { w, bytes } = collector()
    await buildDoc().saveToStream(w)
    await expectValidPdf(new Uint8Array(bytes()))
  })

  test('streaming is byte-deterministic', async () => {
    const a = collector()
    const b = collector()
    await buildDoc().saveToStream(a.w)
    await buildDoc().saveToStream(b.w)
    expect(Buffer.compare(a.bytes(), b.bytes())).toBe(0)
  })

  test('a stream error rejects saveToStream', async () => {
    const w = new Writable({
      write(_c, _e, cb) {
        cb(new Error('disk full'))
      },
    })
    await expect(buildDoc().saveToStream(w)).rejects.toThrow(/disk full/)
  })

  test('a build/conformance error rejects before streaming', async () => {
    const doc = PdfDocument.create(deterministicOpts).setConformance('PDF/X-4')
    doc.addPage({ size: { widthPt: 100, heightPt: 100 } }) // no output intent / boxes
    await expect(doc.saveToStream(collector().w)).rejects.toThrow(ConformanceError)
  })

  test('save() is still single-use via the stream path', async () => {
    const doc = buildDoc()
    await doc.saveToStream(collector().w)
    await expect(doc.saveToStream(collector().w)).rejects.toThrow(PdfGenError)
  })

  test('StreamSink reports the byte length written', async () => {
    const { w, bytes } = collector()
    const sink = new StreamSink(w)
    sink.write(new Uint8Array([1, 2, 3]))
    sink.write(new Uint8Array([4, 5]))
    expect(sink.length).toBe(5)
    await sink.done()
    expect(bytes().length).toBe(5)
  })
})
