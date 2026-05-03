import { describe, expect, test } from 'bun:test'
import { TemplateError } from '@strav/kernel'
import { PendingMail } from '../src/mail/helpers.ts'

// Validation runs synchronously at the top of build(), before any
// MailManager / ViewEngine access — so a no-setup test can prove the
// rejection fires for every traversal-style input. Good names will
// fall through to MailManager.config and hit a "not configured" error,
// which is also a useful invariant: rejection must come first.

describe('PendingMail template-name validation', () => {
  const reject = (name: string) =>
    test(`rejects ${JSON.stringify(name)}`, async () => {
      const pending = new PendingMail('user@example.com').template(name, {})
      await expect(pending.build()).rejects.toBeInstanceOf(TemplateError)
    })

  reject('../secret')
  reject('../../etc/passwd')
  reject('/etc/passwd')
  reject('foo/../bar')
  reject('..\\foo')
  reject('\\windows\\system32')
  reject('.')
  reject('..')
  reject('.hidden')
  reject('-leading-dash')
  reject('emails/../../private')
  reject('foo/bar')
  reject('') // empty name should not match the regex either

  test('accepts simple names', async () => {
    const pending = new PendingMail('user@example.com').template('welcome', {})
    // Validation passes; we expect the call to proceed past validation
    // and fail later (MailManager not initialized in this test). The
    // important assertion is that it does NOT throw a TemplateError.
    await expect(pending.build()).rejects.not.toBeInstanceOf(TemplateError)
  })

  test('accepts dot-separated subpaths', async () => {
    const pending = new PendingMail('user@example.com').template('auth.password-reset', {})
    await expect(pending.build()).rejects.not.toBeInstanceOf(TemplateError)
  })

  test('accepts underscore and hyphen', async () => {
    const pending = new PendingMail('user@example.com').template('invoice_v2-final', {})
    await expect(pending.build()).rejects.not.toBeInstanceOf(TemplateError)
  })

  test('error message names the bad input', async () => {
    const pending = new PendingMail('user@example.com').template('../secret', {})
    await expect(pending.build()).rejects.toThrow(/Invalid mail template name.*"\.\.\/secret"/)
  })
})
