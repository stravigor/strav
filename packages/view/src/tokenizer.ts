import { TemplateError } from '@strav/kernel/exceptions/errors'
export type TokenType = 'text' | 'escaped' | 'raw' | 'comment' | 'directive' | 'vue_island'

export interface VueAttr {
  value: string
  bound: boolean
}

export interface Token {
  type: TokenType
  value: string
  directive?: string
  args?: string
  tag?: string
  attrs?: Record<string, VueAttr>
  line: number
}

const DIRECTIVES = new Set([
  'if',
  'elseif',
  'else',
  'end',
  'each',
  'layout',
  'section',
  'show',
  'include',
  'islands',
  'css',
  'csrf',
  'class',
  'style',
  'push',
  'prepend',
  'stack',
])

export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  let pos = 0
  let line = 1
  let textStart = 0

  function countLines(str: string): number {
    let count = 0
    for (let i = 0; i < str.length; i++) {
      if (str[i] === '\n') count++
    }
    return count
  }

  function flushText(): void {
    if (pos > textStart) {
      const value = source.slice(textStart, pos)
      if (value.length > 0) {
        tokens.push({ type: 'text', value, line: line - countLines(value) })
      }
    }
  }

  function remaining(): string {
    return source.slice(pos)
  }

  while (pos < source.length) {
    const rest = remaining()

    // 1. Comments: {{-- ... --}}
    if (rest.startsWith('{{--')) {
      flushText()
      const endIdx = source.indexOf('--}}', pos + 4)
      if (endIdx === -1) {
        throw new TemplateError(`Unclosed comment at line ${line}`)
      }
      const content = source.slice(pos + 4, endIdx)
      tokens.push({ type: 'comment', value: content.trim(), line })
      line += countLines(source.slice(pos, endIdx + 4))
      pos = endIdx + 4
      textStart = pos
      continue
    }

    // 2. Raw output: {!! ... !!}
    if (rest.startsWith('{!!')) {
      flushText()
      const endIdx = source.indexOf('!!}', pos + 3)
      if (endIdx === -1) {
        throw new TemplateError(`Unclosed raw expression at line ${line}`)
      }
      const expr = source.slice(pos + 3, endIdx).trim()
      tokens.push({ type: 'raw', value: expr, line })
      line += countLines(source.slice(pos, endIdx + 3))
      pos = endIdx + 3
      textStart = pos
      continue
    }

    // 3. Escaped output: {{ ... }}
    if (rest.startsWith('{{')) {
      flushText()
      const endIdx = source.indexOf('}}', pos + 2)
      if (endIdx === -1) {
        throw new TemplateError(`Unclosed expression at line ${line}`)
      }
      const expr = source.slice(pos + 2, endIdx).trim()
      tokens.push({ type: 'escaped', value: expr, line })
      line += countLines(source.slice(pos, endIdx + 2))
      pos = endIdx + 2
      textStart = pos
      continue
    }

    // 4. Vue islands: <vue:name ... /> (supports subpaths like <vue:forms/contact-form />)
    const vueMatch = rest.match(/^<vue:([\w/-]+)((?:\s+[\s\S]*?)?)\/>/)
    if (vueMatch) {
      flushText()
      const tag = vueMatch[1]!
      const attrsRaw = vueMatch[2]!.trim()
      const attrs = parseVueAttrs(attrsRaw)
      const full = vueMatch[0]
      tokens.push({ type: 'vue_island', value: full, tag, attrs, line })
      line += countLines(full)
      pos += full.length
      textStart = pos
      continue
    }

    // 5. Directives: @keyword or @keyword(...)
    const dirMatch = rest.match(/^@(\w+)/)
    if (dirMatch && DIRECTIVES.has(dirMatch[1]!)) {
      flushText()
      const directive = dirMatch[1]!
      pos += dirMatch[0].length
      let args: string | undefined

      // Parse arguments in parentheses (if present)
      if (pos < source.length && source[pos] === '(') {
        const argsStart = pos
        let depth = 1
        pos++ // skip opening (
        while (pos < source.length && depth > 0) {
          if (source[pos] === '(') depth++
          else if (source[pos] === ')') depth--
          if (depth > 0) pos++
        }
        if (depth !== 0) {
          throw new TemplateError(`Unclosed directive arguments at line ${line}`)
        }
        args = source.slice(argsStart + 1, pos)
        pos++ // skip closing )
      }

      tokens.push({ type: 'directive', value: directive, directive, args, line })
      textStart = pos
      continue
    }

    // 6. Regular text
    if (source[pos] === '\n') line++
    pos++
  }

  flushText()
  return tokens
}

function parseVueAttrs(raw: string): Record<string, VueAttr> {
  const attrs: Record<string, VueAttr> = {}
  const attrPattern = /([:@]?[\w.-]+)\s*=\s*"([^"]*)"/g
  let match: RegExpExecArray | null

  while ((match = attrPattern.exec(raw)) !== null) {
    const name = match[1]!
    const value = match[2]!

    if (name.startsWith(':')) {
      // Bound attribute — extract expression from {{ }} if present
      const exprMatch = value.match(/^\{\{\s*(.*?)\s*\}\}$/)
      attrs[name.slice(1)] = {
        value: exprMatch ? exprMatch[1]! : value,
        bound: true,
      }
    } else {
      attrs[name] = { value, bound: false }
    }
  }

  return attrs
}
