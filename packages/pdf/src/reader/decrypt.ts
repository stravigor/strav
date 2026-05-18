/**
 * Standard security handler (spec §7.6), empty user password only.
 *
 * Supports RC4 (40/128-bit, V1–V2), AES-128 (V4/R4) and AES-256 (V5/R5–R6).
 * If the empty user password does not validate — i.e. the file needs a real
 * password — or the handler is non-standard, an {@link EncryptedPdfError} is
 * thrown. Strings and streams are decrypted after parsing, before filtering.
 */

import { createHash, createDecipheriv, createCipheriv } from 'node:crypto'
import {
  type PdfObject,
  type PdfDictionary,
  isNum,
  isStr,
  isName,
  isDict,
} from '../objects/types.ts'
import { EncryptedPdfError } from '../util/errors.ts'

const PAD = Uint8Array.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
])

const md5 = (b: Uint8Array): Uint8Array =>
  new Uint8Array(createHash('md5').update(b).digest())
const sha = (algo: string, b: Uint8Array): Uint8Array =>
  new Uint8Array(createHash(algo).update(b).digest())

function cat(...parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(len)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256)
  for (let i = 0; i < 256; i++) s[i] = i
  let j = 0
  for (let i = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff
    ;[s[i], s[j]] = [s[j]!, s[i]!]
  }
  const out = new Uint8Array(data.length)
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

function aesCbcDecrypt(key: Uint8Array, data: Uint8Array, iv?: Uint8Array): Uint8Array {
  if (data.length < 16) return new Uint8Array(0)
  const useIv = iv ?? data.subarray(0, 16)
  const body = iv ? data : data.subarray(16)
  const algo = key.length === 32 ? 'aes-256-cbc' : 'aes-128-cbc'
  const d = createDecipheriv(algo, key, useIv)
  d.setAutoPadding(false)
  const out = Buffer.concat([d.update(body), d.final()])
  // Strip PKCS#7 padding when it looks valid.
  const pad = out.length ? out[out.length - 1]! : 0
  if (pad >= 1 && pad <= 16 && pad <= out.length) {
    return new Uint8Array(out.subarray(0, out.length - pad))
  }
  return new Uint8Array(out)
}

/** Algorithm 2.B — the R6 hardened hash. */
function hash2B(pwd: Uint8Array, salt: Uint8Array, udata: Uint8Array): Uint8Array {
  let K = sha('sha256', cat(pwd, salt, udata))
  for (let round = 0; ; round++) {
    const block = cat(pwd, K, udata)
    const K1 = new Uint8Array(block.length * 64)
    for (let i = 0; i < 64; i++) K1.set(block, i * block.length)
    const c = createCipheriv('aes-128-cbc', K.subarray(0, 16), K.subarray(16, 32))
    c.setAutoPadding(false)
    const E = new Uint8Array(Buffer.concat([c.update(K1), c.final()]))
    let mod = 0
    for (let i = 0; i < 16; i++) mod += E[i]!
    mod %= 3
    K = sha(mod === 0 ? 'sha256' : mod === 1 ? 'sha384' : 'sha512', E)
    if (round >= 63 && E[E.length - 1]! <= round - 32) break
  }
  return K.subarray(0, 32)
}

export interface Decryptor {
  /** Decrypt a string/stream payload for object (num,gen). */
  decrypt(num: number, gen: number, data: Uint8Array, isString: boolean): Uint8Array
  /** Object number of the /Encrypt dict (never itself decrypted). */
  readonly encryptObjNum: number
}

const strBytes = (o: PdfObject | undefined): Uint8Array =>
  o && isStr(o) ? o.value : new Uint8Array(0)

/**
 * Build a decryptor from the trailer's /Encrypt dict and /ID, validating the
 * empty user password. `encryptObjNum` is the /Encrypt indirect object number.
 */
export function buildDecryptor(
  enc: PdfDictionary,
  idFirst: Uint8Array,
  encryptObjNum: number,
): Decryptor {
  const filter = enc.entries.get('Filter')
  if (!filter || !isName(filter) || filter.value !== 'Standard') {
    throw new EncryptedPdfError('Unsupported security handler (only /Standard)')
  }
  const numOf = (k: string, d = 0): number => {
    const v = enc.entries.get(k)
    return v && isNum(v) ? v.value : d
  }
  const V = numOf('V', 0)
  const R = numOf('R', 0)
  const O = strBytes(enc.entries.get('O'))
  const U = strBytes(enc.entries.get('U'))
  const P = numOf('P', 0) | 0
  const lengthBits = numOf('Length', 40)

  // Determine the algorithm: V5 → AES-256; V4 → /CF /StdCF /CFM; else RC4.
  let cfm: 'V2' | 'AESV2' | 'AESV3' = 'V2'
  if (V >= 5) cfm = 'AESV3'
  else if (V === 4) {
    const cf = enc.entries.get('CF')
    const stmF = enc.entries.get('StmF')
    if (cf && isDict(cf) && stmF && isName(stmF)) {
      const std = cf.entries.get(stmF.value)
      if (std && isDict(std)) {
        const m = std.entries.get('CFM')
        if (m && isName(m)) {
          cfm = m.value === 'AESV3' ? 'AESV3' : m.value === 'AESV2' ? 'AESV2' : 'V2'
        }
      }
    }
  }

  let fileKey: Uint8Array
  if (V >= 5) {
    // AES-256 (R5/R6). Validate empty user password against /U.
    const valSalt = U.subarray(32, 40)
    const keySalt = U.subarray(40, 48)
    const empty = new Uint8Array(0)
    const check =
      R === 5 ? sha('sha256', cat(empty, valSalt)) : hash2B(empty, valSalt, empty)
    if (Buffer.compare(Buffer.from(check), Buffer.from(U.subarray(0, 32))) !== 0) {
      throw new EncryptedPdfError('PDF requires a user password')
    }
    const ikey =
      R === 5 ? sha('sha256', cat(empty, keySalt)) : hash2B(empty, keySalt, empty)
    const UE = strBytes(enc.entries.get('UE'))
    fileKey = aesCbcDecrypt(ikey, UE, new Uint8Array(16))
  } else {
    // RC4 / AES-128 (R2–R4). Algorithm 2 with the empty password.
    const keyLen = R === 2 ? 5 : lengthBits / 8
    const pBytes = Uint8Array.from([P & 0xff, (P >> 8) & 0xff, (P >> 16) & 0xff, (P >> 24) & 0xff])
    const encMeta = enc.entries.get('EncryptMetadata')
    const metaFalse = encMeta && encMeta.kind === 'bool' && encMeta.value === false
    let h = md5(
      cat(
        PAD,
        O,
        pBytes,
        idFirst,
        R >= 4 && metaFalse ? Uint8Array.from([0xff, 0xff, 0xff, 0xff]) : new Uint8Array(0),
      ),
    )
    if (R >= 3) for (let i = 0; i < 50; i++) h = md5(h.subarray(0, keyLen))
    fileKey = h.subarray(0, keyLen)

    // Validate the empty password by reproducing /U (Algorithm 4/5).
    let expectedU: Uint8Array
    if (R === 2) {
      expectedU = rc4(fileKey, PAD)
    } else {
      const idHash = md5(cat(PAD, idFirst))
      let x = rc4(fileKey, idHash)
      for (let i = 1; i <= 19; i++) {
        const k = new Uint8Array(fileKey.length)
        for (let j = 0; j < k.length; j++) k[j] = fileKey[j]! ^ i
        x = rc4(k, x)
      }
      expectedU = x
    }
    const cmpLen = R === 2 ? 32 : 16
    if (
      U.length >= cmpLen &&
      Buffer.compare(
        Buffer.from(expectedU.subarray(0, cmpLen)),
        Buffer.from(U.subarray(0, cmpLen)),
      ) !== 0
    ) {
      throw new EncryptedPdfError('PDF requires a user password')
    }
  }

  const objectKey = (num: number, gen: number, aes: boolean): Uint8Array => {
    const ext = cat(
      fileKey,
      Uint8Array.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff]),
      Uint8Array.from([gen & 0xff, (gen >> 8) & 0xff]),
      aes ? Uint8Array.from([0x73, 0x41, 0x6c, 0x54]) : new Uint8Array(0),
    )
    return md5(ext).subarray(0, Math.min(fileKey.length + 5, 16))
  }

  return {
    encryptObjNum,
    decrypt(num, gen, data, _isString): Uint8Array {
      if (data.length === 0) return data
      if (cfm === 'AESV3') return aesCbcDecrypt(fileKey, data)
      if (cfm === 'AESV2') return aesCbcDecrypt(objectKey(num, gen, true), data)
      return rc4(objectKey(num, gen, false), data)
    },
  }
}
