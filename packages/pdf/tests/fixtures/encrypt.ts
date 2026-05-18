/**
 * Test-only standard-security-handler encryptor (empty user & owner password).
 * Independently implements the spec algorithms so reader_encrypted.test.ts
 * exercises real RC4 / AES-128 / AES-256 decryption paths end-to-end.
 */

import { createHash, createCipheriv, randomBytes } from 'node:crypto'

const PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
])
const md5 = (b: Buffer) => createHash('md5').update(b).digest()

function rc4(key: Buffer, data: Buffer): Buffer {
  const s = Array.from({ length: 256 }, (_, i) => i)
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff
    ;[s[i], s[j]] = [s[j]!, s[i]!]
  }
  const out = Buffer.alloc(data.length)
  let a = 0
  let b = 0
  for (let k = 0; k < data.length; k++) {
    a = (a + 1) & 0xff
    b = (b + s[a]!) & 0xff
    ;[s[a], s[b]] = [s[b]!, s[a]!]
    out[k] = data[k]! ^ s[(s[a]! + s[b]!) & 0xff]!
  }
  return out
}

function pkcs7(data: Buffer): Buffer {
  const pad = 16 - (data.length % 16)
  return Buffer.concat([data, Buffer.alloc(pad, pad)])
}

function aesCbcEnc(key: Buffer, data: Buffer, iv: Buffer): Buffer {
  const c = createCipheriv(key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc', key, iv)
  c.setAutoPadding(false)
  return Buffer.concat([c.update(data), c.final()])
}

function hash2B(pwd: Buffer, salt: Buffer, udata: Buffer): Buffer {
  let K = createHash('sha256').update(Buffer.concat([pwd, salt, udata])).digest()
  for (let round = 0; ; round++) {
    const block = Buffer.concat([pwd, K, udata])
    const K1 = Buffer.concat(Array.from({ length: 64 }, () => block))
    const E = aesCbcEnc(K.subarray(0, 16), K1, K.subarray(16, 32))
    let mod = 0
    for (let i = 0; i < 16; i++) mod += E[i]!
    mod %= 3
    K = createHash(mod === 0 ? 'sha256' : mod === 1 ? 'sha384' : 'sha512')
      .update(E)
      .digest()
    if (round >= 63 && E[E.length - 1]! <= round - 32) break
  }
  return K.subarray(0, 32)
}

const lpad32 = (b: Buffer) => Buffer.concat([b, PAD]).subarray(0, 32)

export interface EncSetup {
  /** Entries to merge into the /Encrypt dictionary (PDF syntax). */
  encryptDict: string
  /** /ID array body, e.g. "<...> <...>". */
  idArray: string
  /** Encrypt a stream/string payload for object (num,gen). */
  enc(num: number, gen: number, data: Uint8Array): Uint8Array
}

const hex = (b: Buffer) => b.toString('hex')
const ID = Buffer.from('00112233445566778899aabbccddeeff', 'hex')

/** RC4, V2 / R3, 128-bit. */
export function rc4Setup(): EncSetup {
  const keyLen = 16
  const P = -44
  const pBuf = Buffer.alloc(4)
  pBuf.writeInt32LE(P, 0)

  let oKey = md5(PAD)
  for (let i = 0; i < 50; i++) oKey = md5(oKey.subarray(0, keyLen))
  oKey = oKey.subarray(0, keyLen)
  let O = rc4(oKey, PAD)
  for (let i = 1; i <= 19; i++) {
    const k = Buffer.from(oKey.map((x) => x ^ i))
    O = rc4(k, O)
  }

  let fileKey = md5(Buffer.concat([PAD, O, pBuf, ID]))
  for (let i = 0; i < 50; i++) fileKey = md5(fileKey.subarray(0, keyLen))
  fileKey = fileKey.subarray(0, keyLen)

  const uh = md5(Buffer.concat([PAD, ID]))
  let U = rc4(fileKey, uh)
  for (let i = 1; i <= 19; i++) {
    const k = Buffer.from(fileKey.map((x) => x ^ i))
    U = rc4(k, U)
  }
  U = Buffer.concat([U, Buffer.alloc(16)]) // pad to 32

  const objKey = (num: number, gen: number) => {
    const ext = Buffer.concat([
      fileKey,
      Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff]),
      Buffer.from([gen & 0xff, (gen >> 8) & 0xff]),
    ])
    return md5(ext).subarray(0, Math.min(keyLen + 5, 16))
  }

  return {
    idArray: `<${hex(ID)}> <${hex(ID)}>`,
    encryptDict: `/Filter/Standard/V 2/R 3/Length 128/P ${P}/O <${hex(O)}> /U <${hex(U)}>`,
    enc: (num, gen, data) => new Uint8Array(rc4(objKey(num, gen), Buffer.from(data))),
  }
}

/** AES-128, V4 / R4 (AESV2). */
export function aesV2Setup(): EncSetup {
  const base = rc4Setup() // identical key derivation (R3/R4, 128-bit)
  // Re-derive fileKey the same way to add the "sAlT" suffix for AES.
  const keyLen = 16
  const P = -44
  const pBuf = Buffer.alloc(4)
  pBuf.writeInt32LE(P, 0)
  const oHex = /\/O <([0-9a-f]+)>/.exec(base.encryptDict)![1]!
  const O = Buffer.from(oHex, 'hex')
  let fileKey = md5(Buffer.concat([PAD, O, pBuf, ID]))
  for (let i = 0; i < 50; i++) fileKey = md5(fileKey.subarray(0, keyLen))
  fileKey = fileKey.subarray(0, keyLen)
  const objKey = (num: number, gen: number) => {
    const ext = Buffer.concat([
      fileKey,
      Buffer.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff]),
      Buffer.from([gen & 0xff, (gen >> 8) & 0xff]),
      Buffer.from('sAlT'),
    ])
    return md5(ext).subarray(0, Math.min(keyLen + 5, 16))
  }
  const uHex = /\/U <([0-9a-f]+)>/.exec(base.encryptDict)![1]!
  return {
    idArray: base.idArray,
    encryptDict:
      `/Filter/Standard/V 4/R 4/Length 128/P ${P}` +
      `/CF<</StdCF<</CFM/AESV2/Length 16>>>>/StmF/StdCF/StrF/StdCF` +
      `/O <${oHex}> /U <${uHex}>`,
    enc: (num, gen, data) => {
      const iv = randomBytes(16)
      return new Uint8Array(
        Buffer.concat([iv, aesCbcEnc(objKey(num, gen), pkcs7(Buffer.from(data)), iv)]),
      )
    },
  }
}

/** AES-256, V5 / R6. */
export function aes256Setup(): EncSetup {
  const fileKey = randomBytes(32)
  const uvs = randomBytes(8)
  const uks = randomBytes(8)
  const empty = Buffer.alloc(0)
  const U = Buffer.concat([hash2B(empty, uvs, empty), uvs, uks])
  const UE = aesCbcEnc(hash2B(empty, uks, empty), fileKey, Buffer.alloc(16))
  // Owner entries are unused by the reader's empty-user-password path; supply
  // syntactically valid placeholders.
  const O = Buffer.concat([hash2B(empty, randomBytes(8), U), randomBytes(8), randomBytes(8)])
  const OE = aesCbcEnc(fileKey, fileKey, Buffer.alloc(16))

  return {
    idArray: `<${hex(ID)}> <${hex(ID)}>`,
    encryptDict:
      `/Filter/Standard/V 5/R 6/Length 256/P -4` +
      `/CF<</StdCF<</CFM/AESV3/Length 32>>>>/StmF/StdCF/StrF/StdCF` +
      `/O <${hex(O)}> /OE <${hex(OE)}> /U <${hex(U)}> /UE <${hex(UE)}>`,
    enc: (_num, _gen, data) => {
      const iv = randomBytes(16)
      return new Uint8Array(
        Buffer.concat([iv, aesCbcEnc(fileKey, pkcs7(Buffer.from(data)), iv)]),
      )
    },
  }
}

export { lpad32 }
