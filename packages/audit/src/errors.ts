import { StravError } from '@strav/kernel'

export class AuditError extends StravError {}

export class ChainBrokenError extends AuditError {
  constructor(public readonly brokenAt: number) {
    super(`Audit chain broken at id=${brokenAt}`)
  }
}
