import { describe, it, expect, test } from 'bun:test'
import { tokenize } from '../src/tokenizer.ts'
import { compile } from '../src/compiler.ts'
import { escapeHtml } from '../src/escape.ts'

/**
 * Compile a template string and evaluate it with the given data.
 * Returns the rendered HTML output.
 */
async function render(template: string, data: Record<string, unknown> = {}): Promise<string> {
  const tokens = tokenize(template)
  const result = compile(tokens)
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
  const fn = new AsyncFunction('__data', '__escape', '__include', `with (__data) {\n${result.code}\n}`)
  const output = await fn(data, escapeHtml, () => '')
  return output.output
}

describe('Code Block Handling', () => {

  describe('tokenizer', () => {
    it('should treat content inside <code> tags as raw text', () => {
      const source = 'Before <code>{{ variable }}</code> After'
      const tokens = tokenize(source)

      expect(tokens).toHaveLength(3)
      expect(tokens[0]).toEqual({ type: 'text', value: 'Before ', line: 1 })
      expect(tokens[1]).toEqual({ type: 'text', value: '<code>{{ variable }}</code>', line: 1 })
      expect(tokens[2]).toEqual({ type: 'text', value: ' After', line: 1 })
    })

    it('should handle multiple template syntaxes in code blocks', () => {
      const source = '<code>{{ var }} @if(test) {!! raw !!} @end</code>'
      const tokens = tokenize(source)

      expect(tokens).toHaveLength(1)
      expect(tokens[0]).toEqual({
        type: 'text',
        value: '<code>{{ var }} @if(test) {!! raw !!} @end</code>',
        line: 1
      })
    })

    it('should handle nested code tags', () => {
      const source = '<code>Outer <code>Inner {{ var }}</code> Still outer</code>'
      const tokens = tokenize(source)

      expect(tokens).toHaveLength(1)
      expect(tokens[0]).toEqual({
        type: 'text',
        value: '<code>Outer <code>Inner {{ var }}</code> Still outer</code>',
        line: 1
      })
    })

    it('should handle multi-line code blocks', () => {
      const source = `<code>
function test() {
  return {{ value }};
}
@if(condition)
  doSomething()
@end
</code>`
      const tokens = tokenize(source)

      expect(tokens).toHaveLength(1)
      expect(tokens[0]!.type).toBe('text')
      expect(tokens[0]!.value).toContain('{{ value }}')
      expect(tokens[0]!.value).toContain('@if(condition)')
      expect(tokens[0]!.value).toContain('@end')
    })

    it('should be case-insensitive for code tags', () => {
      const source1 = '<CODE>{{ variable }}</CODE>'
      const source2 = '<Code>{{ variable }}</Code>'
      const source3 = '<code>{{ variable }}</CODE>'

      const tokens1 = tokenize(source1)
      const tokens2 = tokenize(source2)
      const tokens3 = tokenize(source3)

      expect(tokens1).toHaveLength(1)
      expect(tokens1[0]).toEqual({
        type: 'text',
        value: '<CODE>{{ variable }}</CODE>',
        line: 1
      })

      expect(tokens2).toHaveLength(1)
      expect(tokens2[0]).toEqual({
        type: 'text',
        value: '<Code>{{ variable }}</Code>',
        line: 1
      })

      expect(tokens3).toHaveLength(1)
      expect(tokens3[0]).toEqual({
        type: 'text',
        value: '<code>{{ variable }}</CODE>',
        line: 1
      })
    })

    it('should handle code tags with attributes', () => {
      const source = '<code class="language-javascript">{{ variable }}</code>'
      const tokens = tokenize(source)

      expect(tokens).toHaveLength(1)
      expect(tokens[0]).toEqual({
        type: 'text',
        value: '<code class="language-javascript">{{ variable }}</code>',
        line: 1
      })
    })

    it('should handle unclosed code tags as regular text', () => {
      const source = '<code>{{ variable }}'
      const tokens = tokenize(source)

      // The <code> without closing tag should be treated as regular text
      // and {{ variable }} should be parsed as a template expression
      expect(tokens.length).toBeGreaterThan(1)
      const hasEscapedToken = tokens.some(t => t.type === 'escaped' && t.value === 'variable')
      expect(hasEscapedToken).toBe(true)
    })

    it('should handle pre+code blocks', () => {
      const source = `<pre><code>
const x = {{ value }};
@each item in items
  console.log(item);
@end
</code></pre>`
      const tokens = tokenize(source)

      // <pre> is not special, but <code> content should still be protected
      expect(tokens.some(t => t.value.includes('<code>'))).toBe(true)
      expect(tokens.some(t => t.value.includes('{{ value }}'))).toBe(true)
      expect(tokens.some(t => t.value.includes('@each item in items'))).toBe(true)
    })

    it('should process template syntax outside code blocks normally', () => {
      const source = '{{ before }} <code>{{ inside }}</code> {{ after }}'
      const tokens = tokenize(source)

      // Should have: escaped(before), text(<code>...</code>), escaped(after)
      const escapedTokens = tokens.filter(t => t.type === 'escaped')
      expect(escapedTokens).toHaveLength(2)
      expect(escapedTokens[0]!.value).toBe('before')
      expect(escapedTokens[1]!.value).toBe('after')

      const codeBlockToken = tokens.find(t => t.type === 'text' && t.value.includes('<code>'))
      expect(codeBlockToken).toBeDefined()
      expect(codeBlockToken!.value).toBe('<code>{{ inside }}</code>')
    })

    it('should handle multiple code blocks in the same template', () => {
      const source = `
        <p>Example 1: <code>{{ var1 }}</code></p>
        <p>Example 2: <code>@if(test)</code></p>
        <p>Result: {{ actualVariable }}</p>
        <p>Example 3: <code>{!! raw !!}</code></p>
      `
      const tokens = tokenize(source)

      // Count code blocks (should be treated as text)
      const codeBlocks = tokens.filter(t =>
        t.type === 'text' && t.value.includes('<code>')
      )
      expect(codeBlocks.length).toBeGreaterThanOrEqual(3)

      // Should have one escaped token for actualVariable
      const escapedTokens = tokens.filter(t => t.type === 'escaped')
      expect(escapedTokens).toHaveLength(1)
      expect(escapedTokens[0]!.value).toBe('actualVariable')
    })
  })

  describe('full rendering', () => {
    it('should render template syntax literally inside code blocks', async () => {
      const template = `
        <h1>Template Syntax Examples</h1>
        <p>Variables: <code>{{ userName }}</code></p>
        <p>Conditionals: <code>@if(isLoggedIn) Show this @end</code></p>
        <p>Raw output: <code>{!! html !!}</code></p>
        <p>Actual variable: {{ testValue }}</p>
      `

      const result = await render(template, { testValue: 'Hello' })

      // Code blocks should contain literal template syntax
      expect(result).toContain('<code>{{ userName }}</code>')
      expect(result).toContain('<code>@if(isLoggedIn) Show this @end</code>')
      expect(result).toContain('<code>{!! html !!}</code>')

      // Actual variable should be replaced
      expect(result).toContain('Actual variable: Hello')
      expect(result).not.toContain('{{ testValue }}')
    })

    it('should handle complex code examples', async () => {
      const template = `
        <h2>Code Example</h2>
        <pre><code>
// Strav template example
@layout('app')

@section('content')
  <h1>{{ title }}</h1>
  @if(user.isAdmin)
    <a href="/admin">Admin Panel</a>
  @end

  @each post in posts
    <article>{{ post.title }}</article>
  @end
@end
</code></pre>
        <p>This is outside: {{ realVariable }}</p>
      `

      const result = await render(template, { realVariable: 'Works!' })

      // All template syntax in code block should be literal
      expect(result).toContain("@layout('app')")
      expect(result).toContain('@section(\'content\')')
      expect(result).toContain('{{ title }}')
      expect(result).toContain('@if(user.isAdmin)')
      expect(result).toContain('@each post in posts')
      expect(result).toContain('{{ post.title }}')

      // Real variable outside should work
      expect(result).toContain('This is outside: Works!')
    })
  })
})