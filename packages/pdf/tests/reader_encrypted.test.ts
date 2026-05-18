import { describe, test, expect } from 'bun:test'
import { extractText } from '../src/reader/extract.ts'
import { EncryptedPdfError } from '../src/util/errors.ts'
import { buildClassicPdf, cat } from './fixtures/classic_pdf.ts'
import { rc4Setup, aesV2Setup, aes256Setup, type EncSetup } from './fixtures/encrypt.ts'

const F1 = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>'

function encryptedPdf(setup: EncSetup, secret: string): Uint8Array {
  const content = `BT /F1 12 Tf 20 150 Td (${secret}) Tj ET`
  const encBytes = setup.enc(4, 0, new TextEncoder().encode(content))
  const streamObj = cat([
    `<</Length ${encBytes.length}>>\nstream\n`,
    encBytes,
    '\nendstream',
  ])
  return buildClassicPdf(
    [
      { num: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
      { num: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
      {
        num: 3,
        body: '<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>',
      },
      { num: 4, body: streamObj },
      { num: 5, body: F1 },
      { num: 6, body: `<<${setup.encryptDict}>>` },
    ],
    { Root: '1 0 R', Encrypt: '6 0 R', ID: `[${setup.idArray}]` },
  )
}

describe('decryption — standard handler, empty password', () => {
  test('RC4 128-bit (V2/R3)', async () => {
    const r = await extractText(encryptedPdf(rc4Setup(), 'rc4 secret text'))
    expect(r.info.encrypted).toBe(true)
    expect(r.pages[0]!.text).toContain('rc4 secret text')
  })

  test('AES-128 (V4/R4, AESV2)', async () => {
    const r = await extractText(encryptedPdf(aesV2Setup(), 'aes128 payload'))
    expect(r.pages[0]!.text).toContain('aes128 payload')
  })

  test('AES-256 (V5/R6, AESV3)', async () => {
    const r = await extractText(encryptedPdf(aes256Setup(), 'aes256 payload'))
    expect(r.pages[0]!.text).toContain('aes256 payload')
  })

  test('non-empty password is rejected', async () => {
    const bytes = encryptedPdf(rc4Setup(), 'x')
    await expect(extractText(bytes, { password: 'hunter2' })).rejects.toBeInstanceOf(
      EncryptedPdfError,
    )
  })

  test('a file needing a real password throws (U mismatch)', async () => {
    const setup = rc4Setup()
    // Corrupt /U so empty-password validation fails.
    setup.encryptDict = setup.encryptDict.replace(/\/U <([0-9a-f]+)>/, '/U <' + '00'.repeat(32) + '>')
    await expect(extractText(encryptedPdf(setup, 'nope'))).rejects.toBeInstanceOf(
      EncryptedPdfError,
    )
  })
})
