import { describe, test, expect } from 'bun:test'
import './setup.ts'
import { tokenize } from '@strav/view'
import { compile } from '@strav/view'
import { captchaHelper } from '../src/view_helper.ts'

describe('@captcha view directive', () => {
  test('tokenizes and compiles bare @captcha', () => {
    const tokens = tokenize('<form>@captcha</form>')
    const directive = tokens.find(t => t.type === 'directive')
    expect(directive?.directive).toBe('captcha')

    const result = compile(tokens)
    expect(result.code).toContain('__captcha')
    expect(result.code).toContain("typeof __captcha === 'function'")
  })

  test('compiles @captcha("pow") with the variant', () => {
    const tokens = tokenize('@captcha("pow")')
    const result = compile(tokens)
    expect(result.code).toContain('__captcha("pow")')
  })

  test('compiles @captcha("svg")', () => {
    const tokens = tokenize('@captcha("svg")')
    const result = compile(tokens)
    expect(result.code).toContain('__captcha("svg")')
  })

  test('helper renders honeypot for bare call', () => {
    const html = captchaHelper()
    expect(html).toContain('aria-hidden="true"')
    expect(html).toContain('name="website"')
    expect(html).toContain('tabindex="-1"')
    // No challenge fields when honeypot-only
    expect(html).not.toContain('name="_captcha"')
  })

  test('helper renders pow variant', () => {
    const html = captchaHelper('pow')
    expect(html).toContain('name="website"') // honeypot still present
    expect(html).toContain('name="_captcha"')
    expect(html).toContain('name="_captcha_answer"')
    expect(html).toContain('data-vue="captcha/pow"')
    expect(html).toContain('data-props=')
  })

  test('helper renders svg variant', () => {
    const html = captchaHelper('svg')
    expect(html).toContain('name="website"')
    expect(html).toContain('name="_captcha"')
    expect(html).toContain('name="_captcha_answer"')
    expect(html).toContain('<svg')
    expect(html).toContain('data-vue="captcha/refresh"')
  })

  test('helper rejects unknown variants', () => {
    expect(() => captchaHelper('bogus')).toThrow(/unknown variant/)
  })
})
