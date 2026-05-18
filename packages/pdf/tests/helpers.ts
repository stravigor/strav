/**
 * Shared test helpers. `qpdf` is NOT a dependency (spec §18.2): if it is not on
 * PATH the structural check is skipped with a warning instead of failing.
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'

let qpdfChecked = false
let qpdfAvailable = false

async function hasQpdf(): Promise<boolean> {
  if (qpdfChecked) return qpdfAvailable
  qpdfChecked = true
  try {
    const p = Bun.spawn(['qpdf', '--version'], { stdout: 'ignore', stderr: 'ignore' })
    qpdfAvailable = (await p.exited) === 0
  } catch {
    qpdfAvailable = false
  }
  if (!qpdfAvailable) {
    console.warn('[pdf tests] qpdf not found on PATH — skipping structural --check')
  }
  return qpdfAvailable
}

/** Run `qpdf --check` on the bytes. Returns true if valid, null if skipped. */
export async function qpdfCheck(bytes: Uint8Array): Promise<boolean | null> {
  if (!(await hasQpdf())) return null
  const dir = mkdtempSync(join(tmpdir(), 'strav-pdf-'))
  const file = join(dir, 'doc.pdf')
  try {
    writeFileSync(file, bytes)
    const p = Bun.spawn(['qpdf', '--check', file], { stdout: 'pipe', stderr: 'pipe' })
    const code = await p.exited
    if (code !== 0) {
      const out = await new Response(p.stdout).text()
      const err = await new Response(p.stderr).text()
      console.error('[qpdf --check failed]\n' + out + err)
    }
    return code === 0
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** Assert qpdf validity unless qpdf is unavailable (then skip silently). */
export async function expectValidPdf(bytes: Uint8Array): Promise<void> {
  const ok = await qpdfCheck(bytes)
  if (ok === null) return
  if (!ok) throw new Error('qpdf --check reported the generated PDF as invalid')
}

const FIXED_ID = '00112233445566778899aabbccddeeff'
export const deterministicOpts = {
  creationDate: new Date(0),
  documentId: FIXED_ID,
}
