const ESC = '\x1b'
const ARROW_UP = `${ESC}[A`
const ARROW_DOWN = `${ESC}[B`
const ENTER = '\r'

interface Choice {
  label: string
  value: string
  description: string
}

export async function select(message: string, choices: Choice[]): Promise<string> {
  let selected = 0

  const render = () => {
    // Move cursor up to overwrite previous render (except first time)
    process.stdout.write(`\x1b[${choices.length}A`)
    for (let i = 0; i < choices.length; i++) {
      const prefix = i === selected ? '\x1b[36m>\x1b[0m' : ' '
      const choice = choices[i]!
      const label = i === selected ? `\x1b[1m${choice.label}\x1b[0m` : choice.label
      const desc = `\x1b[2m${choice.description}\x1b[0m`
      process.stdout.write(`\x1b[2K  ${prefix} ${label}  ${desc}\n`)
    }
  }

  process.stdout.write(`  \x1b[1m${message}\x1b[0m\n`)
  // Print initial lines so render() can overwrite them
  for (const choice of choices) {
    process.stdout.write('\n')
  }
  render()

  return new Promise(resolve => {
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    let buffer = ''

    const onData = (data: string) => {
      buffer += data

      // Check for Ctrl+C
      if (buffer.includes('\x03')) {
        stdin.setRawMode(false)
        stdin.pause()
        stdin.removeListener('data', onData)
        process.stdout.write('\n')
        process.exit(0)
      }

      // Process escape sequences
      while (buffer.length > 0) {
        if (buffer.startsWith(ARROW_UP)) {
          selected = (selected - 1 + choices.length) % choices.length
          render()
          buffer = buffer.slice(ARROW_UP.length)
        } else if (buffer.startsWith(ARROW_DOWN)) {
          selected = (selected + 1) % choices.length
          render()
          buffer = buffer.slice(ARROW_DOWN.length)
        } else if (buffer.startsWith(ENTER)) {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.removeListener('data', onData)
          resolve(choices[selected]!.value)
          buffer = ''
          return
        } else if (buffer.startsWith(ESC)) {
          // Incomplete escape sequence, wait for more data
          break
        } else {
          // Discard unrecognized input
          buffer = buffer.slice(1)
        }
      }
    }

    stdin.on('data', onData)
  })
}

export async function input(message: string, defaultValue: string): Promise<string> {
  process.stdout.write(`  \x1b[1m${message}\x1b[0m \x1b[2m(${defaultValue})\x1b[0m `)

  return new Promise(resolve => {
    const stdin = process.stdin
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    let value = ''

    const onData = (data: string) => {
      for (const char of data) {
        if (char === '\x03') {
          // Ctrl+C
          stdin.setRawMode(false)
          stdin.pause()
          stdin.removeListener('data', onData)
          process.stdout.write('\n')
          process.exit(0)
        }

        if (char === '\r' || char === '\n') {
          stdin.setRawMode(false)
          stdin.pause()
          stdin.removeListener('data', onData)
          process.stdout.write('\n')
          resolve(value || defaultValue)
          return
        }

        if (char === '\x7f' || char === '\b') {
          // Backspace
          if (value.length > 0) {
            value = value.slice(0, -1)
            process.stdout.write('\b \b')
          }
          continue
        }

        // Printable characters
        if (char >= ' ') {
          value += char
          process.stdout.write(char)
        }
      }
    }

    stdin.on('data', onData)
  })
}