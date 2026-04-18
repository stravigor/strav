import { TemplateError } from '@strav/kernel/exceptions/errors'
import type { Token } from './tokenizer.ts'

export interface CompilationResult {
  code: string
  layout?: string
}

interface StackEntry {
  type: 'if' | 'each' | 'section' | 'push' | 'prepend'
  line: number
  blockName?: string
  stackName?: string
}

function escapeJs(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
}

/**
 * Parse a conditional array like `['p-4', 'bold' => isActive, 'dim' => !isActive]`.
 * Returns an array of JS expressions:
 *   - plain entries stay as-is: `'p-4'`
 *   - `'value' => condition` becomes `(condition) ? 'value' : ''`
 */
function parseConditionalArray(args: string): string[] {
  // Strip outer whitespace and brackets: "[ ... ]" → "..."
  let inner = args.trim()
  if (inner.startsWith('[') && inner.endsWith(']')) {
    inner = inner.slice(1, -1)
  }

  // Split by top-level commas (respect quotes, parens, brackets)
  const entries: string[] = []
  let current = ''
  let depth = 0      // ( )
  let bracketDepth = 0 // [ ]
  let inSingle = false
  let inDouble = false
  let inBacktick = false

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i]!
    const prev = i > 0 ? inner[i - 1] : ''

    if (prev !== '\\') {
      if (ch === "'" && !inDouble && !inBacktick) inSingle = !inSingle
      else if (ch === '"' && !inSingle && !inBacktick) inDouble = !inDouble
      else if (ch === '`' && !inSingle && !inDouble) inBacktick = !inBacktick
    }

    const inString = inSingle || inDouble || inBacktick

    if (!inString) {
      if (ch === '(') depth++
      else if (ch === ')') depth--
      else if (ch === '[') bracketDepth++
      else if (ch === ']') bracketDepth--
      else if (ch === ',' && depth === 0 && bracketDepth === 0) {
        entries.push(current.trim())
        current = ''
        continue
      }
    }

    current += ch
  }

  const last = current.trim()
  if (last) entries.push(last)

  // Transform each entry
  return entries.map(entry => {
    // Match: 'value' => condition  or  "value" => condition
    const arrowMatch = entry.match(/^(['"])(.*?)\1\s*=>\s*(.+)$/)
    if (arrowMatch) {
      const value = arrowMatch[1]! + arrowMatch[2]! + arrowMatch[1]!
      const condition = arrowMatch[3]!.trim()
      return `(${condition}) ? ${value} : ''`
    }
    // Plain expression — pass through
    return entry
  })
}

export function compile(tokens: Token[]): CompilationResult {
  const lines: string[] = []
  const stack: StackEntry[] = []
  let layout: string | undefined

  lines.push('let __out = "";')
  lines.push('const __blocks = {};')
  lines.push('const __stacks = {};')
  lines.push('const __variables = {};')

  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        lines.push(`__out += "${escapeJs(token.value)}";`)
        break

      case 'escaped':
        lines.push(`__out += __escape(${token.value});`)
        break

      case 'raw':
        lines.push(`__out += (${token.value});`)
        break

      case 'comment':
        // Stripped from output
        break

      case 'vue_island': {
        const attrs = token.attrs ?? {}
        const propParts: string[] = []
        for (const [name, attr] of Object.entries(attrs)) {
          if (attr.bound) {
            propParts.push(`${JSON.stringify(name)}: (${attr.value})`)
          } else {
            propParts.push(`${JSON.stringify(name)}: ${JSON.stringify(attr.value)}`)
          }
        }
        const propsExpr = `{${propParts.join(', ')}}`
        const tag = escapeJs(token.tag!)
        lines.push('__out += \'<div data-vue="' + tag + '"\'')
        lines.push(
          '  + " data-props=\'" + JSON.stringify(' + propsExpr + ").replace(/'/g, '&#39;') + \"'\""
        )
        lines.push("  + '></div>';")

        break
      }

      case 'directive':
        compileDirective(token, lines, stack, l => {
          layout = l
        })
        break
    }
  }

  if (stack.length > 0) {
    const unclosed = stack[stack.length - 1]!
    throw new TemplateError(`Unclosed @${unclosed.type} block (opened at line ${unclosed.line})`)
  }

  lines.push('return { output: __out, blocks: __blocks, stacks: __stacks, variables: __variables };')

  return { code: lines.join('\n'), layout }
}

function compileDirective(
  token: Token,
  lines: string[],
  stack: StackEntry[],
  setLayout: (name: string) => void
): void {
  switch (token.directive) {
    case 'if':
      if (!token.args) throw new TemplateError(`@if requires a condition at line ${token.line}`)
      lines.push(`if (${token.args}) {`)
      stack.push({ type: 'if', line: token.line })
      break

    case 'elseif':
      if (!token.args) throw new TemplateError(`@elseif requires a condition at line ${token.line}`)
      if (!stack.length || stack[stack.length - 1]!.type !== 'if') {
        throw new TemplateError(`@elseif without matching @if at line ${token.line}`)
      }
      lines.push(`} else if (${token.args}) {`)
      break

    case 'else':
      if (!stack.length || stack[stack.length - 1]!.type !== 'if') {
        throw new TemplateError(`@else without matching @if at line ${token.line}`)
      }
      lines.push(`} else {`)
      break

    case 'each': {
      if (!token.args) throw new TemplateError(`@each requires arguments at line ${token.line}`)
      const match = token.args.match(/^\s*(\w+)\s+in\s+(.+)$/)
      if (!match) {
        throw new TemplateError(`@each syntax error at line ${token.line}: expected "item in list"`)
      }
      const itemName = match[1]!
      const listExpr = match[2]!.trim()
      lines.push(`{`)
      lines.push(`  const __list = (${listExpr});`)
      lines.push(`  for (let $index = 0; $index < __list.length; $index++) {`)
      lines.push(`    const ${itemName} = __list[$index];`)
      lines.push(`    const $first = $index === 0;`)
      lines.push(`    const $last = $index === __list.length - 1;`)
      stack.push({ type: 'each', line: token.line })
      break
    }

    case 'layout': {
      if (!token.args) throw new TemplateError(`@layout requires a name at line ${token.line}`)
      const name = token.args.replace(/^['"]|['"]$/g, '').trim()
      setLayout(name)
      break
    }

    case 'section': {
      if (!token.args) throw new TemplateError(`@section requires a name at line ${token.line}`)
      const name = token.args.replace(/^['"]|['"]$/g, '').trim()
      const nameStr = JSON.stringify(name)
      // Capture content between @section and @end into __blocks.
      // Does not output inline — content flows to parent layout via result.blocks.
      lines.push(`__blocks[${nameStr}] = (function() { let __out = "";`)
      stack.push({ type: 'section', line: token.line, blockName: name })
      break
    }

    case 'show': {
      if (!token.args) throw new TemplateError(`@show requires a name at line ${token.line}`)

      // Parse arguments: either "name" or "name", "fallback"
      const match = token.args.match(/^\s*['"]([^'"]+)['"]\s*(?:,\s*['"]([^'"]*)['"]\s*)?$/)
      if (!match) {
        throw new TemplateError(`@show syntax error at line ${token.line}: expected "'name'" or "'name', 'fallback'"`)
      }

      const name = match[1]!
      const fallback = match[2] || ''
      const nameStr = JSON.stringify(name)
      const fallbackStr = JSON.stringify(fallback)

      // Output block content: prefer child-provided variable, fall back to __blocks, then fallback value
      lines.push(`if (typeof ${name} !== 'undefined' && ${name} !== null) {`)
      lines.push(`  __out += ${name};`)
      lines.push(`} else if (__blocks[${nameStr}]) {`)
      lines.push(`  __out += __blocks[${nameStr}];`)
      lines.push(`} else {`)
      lines.push(`  __out += ${fallbackStr};`)
      lines.push(`}`)
      break
    }

    case 'include': {
      if (!token.args) throw new TemplateError(`@include requires arguments at line ${token.line}`)
      const match = token.args.match(/^\s*['"]([^'"]+)['"]\s*(?:,\s*(.+))?\s*$/)
      if (!match) {
        throw new TemplateError(
          `@include syntax error at line ${token.line}: expected "'name'" or "'name', data"`
        )
      }
      const name = match[1]!
      const dataExpr = match[2] ? match[2].trim() : '{}'
      lines.push(`__out += await __include(${JSON.stringify(name)}, ${dataExpr});`)
      break
    }

    case 'islands': {
      const src = token.args ? token.args.replace(/^['"]|['"]$/g, '').trim() : '/islands.js'
      // Use __islandsSrc (set by IslandBuilder via ViewEngine.setGlobal) for versioned URL, fallback to static src
      lines.push(
        `__out += '<script src="' + (typeof __islandsSrc !== 'undefined' ? __islandsSrc : '${escapeJs(src)}') + '"><\\/script>';`
      )
      break
    }

    case 'css': {
      if (!token.args) {
        // No arguments: include all CSS files
        lines.push(`
          if (typeof __cssSrcArray !== 'undefined' && __cssSrcArray.length > 0) {
            for (var i = 0; i < __cssSrcArray.length; i++) {
              __out += '<link rel="stylesheet" href="' + __cssSrcArray[i] + '">';
            }
          } else if (typeof __cssSrc !== 'undefined') {
            // Fallback to single CSS for backward compatibility
            __out += '<link rel="stylesheet" href="' + __cssSrc + '">';
          }
        `.trim())
      } else {
        // With argument: include specific named CSS file
        const key = token.args.replace(/^['"]|['"]$/g, '').trim()
        lines.push(`
          if (typeof __cssSrcs !== 'undefined' && __cssSrcs['${escapeJs(key)}']) {
            __out += '<link rel="stylesheet" href="' + __cssSrcs['${escapeJs(key)}'] + '">';
          } else if ('${escapeJs(key)}' === 'default' && typeof __cssSrc !== 'undefined') {
            // Fallback to single CSS for 'default' key
            __out += '<link rel="stylesheet" href="' + __cssSrc + '">';
          }
        `.trim())
      }
      break
    }

    case 'class': {
      if (!token.args) throw new TemplateError(`@class requires arguments at line ${token.line}`)
      const classEntries = parseConditionalArray(token.args)
      const classExpr = `[${classEntries.join(', ')}].filter(Boolean).join(' ')`
      lines.push(`__out += 'class="' + __escape(${classExpr}) + '"';`)
      break
    }

    case 'style': {
      if (!token.args) throw new TemplateError(`@style requires arguments at line ${token.line}`)
      const styleEntries = parseConditionalArray(token.args)
      const styleExpr = `[${styleEntries.join(', ')}].filter(Boolean).join('; ')`
      lines.push(`__out += 'style="' + __escape(${styleExpr}) + '"';`)
      break
    }

    case 'csrf':
      lines.push(
        `__out += '<input type="hidden" name="_token" value="' + __escape(csrfToken) + '">';`
      )
      break

    case 'push': {
      if (!token.args) throw new TemplateError(`@push requires a name at line ${token.line}`)
      const name = token.args.replace(/^['"]|['"]$/g, '').trim()
      const nameStr = JSON.stringify(name)
      // Initialize stack array if it doesn't exist, then capture content and push
      lines.push(`if (!__stacks[${nameStr}]) __stacks[${nameStr}] = [];`)
      lines.push(`__stacks[${nameStr}].push((function() { let __out = "";`)
      stack.push({ type: 'push', line: token.line, stackName: name })
      break
    }

    case 'prepend': {
      if (!token.args) throw new TemplateError(`@prepend requires a name at line ${token.line}`)
      const name = token.args.replace(/^['"]|['"]$/g, '').trim()
      const nameStr = JSON.stringify(name)
      // Initialize stack array if it doesn't exist, then capture content and unshift
      lines.push(`if (!__stacks[${nameStr}]) __stacks[${nameStr}] = [];`)
      lines.push(`__stacks[${nameStr}].unshift((function() { let __out = "";`)
      stack.push({ type: 'prepend', line: token.line, stackName: name })
      break
    }

    case 'stack': {
      if (!token.args) throw new TemplateError(`@stack requires a name at line ${token.line}`)
      const name = token.args.replace(/^['"]|['"]$/g, '').trim()
      const nameStr = JSON.stringify(name)
      // Output joined stack content - merge local and passed stacks
      lines.push(`{`)
      lines.push(`  const __mergedStack = [...((__data.__stacks && __data.__stacks[${nameStr}]) || []), ...(__stacks[${nameStr}] || [])];`)
      lines.push(`  __out += __mergedStack.join('');`)
      lines.push(`}`)
      break
    }

    case 'set': {
      if (!token.args) throw new TemplateError(`@set requires arguments at line ${token.line}`)

      // Parse arguments: @set('name', 'value')
      const match = token.args.match(/^\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]*)['"]?\s*$/)
      if (!match) {
        throw new TemplateError(`@set syntax error at line ${token.line}: expected @set('name', 'value'). Got: "${token.args}"`)
      }

      const name = match[1]!
      const value = match[2]!
      const nameStr = JSON.stringify(name)
      const valueStr = JSON.stringify(value)

      // Store variable in __variables object
      lines.push(`__variables[${nameStr}] = ${valueStr};`)
      break
    }

    case 'end': {
      if (!stack.length) {
        throw new TemplateError(`Unexpected @end at line ${token.line} — no open block`)
      }
      const top = stack.pop()!
      if (top.type === 'section') {
        lines.push(`  return __out; })();`)
      } else if (top.type === 'push' || top.type === 'prepend') {
        lines.push(`  return __out; })());`)
      } else if (top.type === 'each') {
        lines.push(`  }`) // close for loop
        lines.push(`}`) // close block scope
      } else {
        lines.push(`}`)
      }
      break
    }
  }
}
