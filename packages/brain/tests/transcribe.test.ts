import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { OpenAIProvider } from '../src/providers/openai_provider.ts'
import { GoogleProvider } from '../src/providers/google_provider.ts'
import { AnthropicProvider } from '../src/providers/anthropic_provider.ts'
import BrainManager from '../src/brain_manager.ts'

const originalFetch = globalThis.fetch

interface CapturedCall {
  url: string
  init: any
  body?: any
  formData?: FormData
}

let lastCall: CapturedCall | undefined

function mockFetchJson(response: any, status = 200): void {
  globalThis.fetch = async (url: any, init: any) => {
    const captured: CapturedCall = { url: String(url), init }
    if (init?.body instanceof FormData) {
      captured.formData = init.body
    } else if (typeof init?.body === 'string') {
      try {
        captured.body = JSON.parse(init.body)
      } catch {
        captured.body = init.body
      }
    }
    lastCall = captured
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

beforeEach(() => {
  lastCall = undefined
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('OpenAIProvider.transcribe', () => {
  const provider = new OpenAIProvider({
    driver: 'openai',
    apiKey: 'test-key',
    model: 'gpt-4o',
    baseUrl: 'https://api.openai.test',
    maxRetries: 0,
  })

  test('posts multipart form to /v1/audio/transcriptions with bearer auth', async () => {
    mockFetchJson({ text: 'hello world', language: 'en', duration: 1.5 })
    const bytes = new Uint8Array([1, 2, 3, 4])

    const result = await provider.transcribe({
      audio: bytes,
      contentType: 'audio/m4a',
      language: 'en',
    })

    expect(result.text).toBe('hello world')
    expect(result.language).toBe('en')
    expect(result.duration).toBe(1.5)
    expect(lastCall!.url).toBe('https://api.openai.test/v1/audio/transcriptions')
    expect(lastCall!.init.headers.Authorization).toBe('Bearer test-key')
    // No explicit content-type — the runtime must derive it from the FormData
    // boundary; setting it manually breaks the upload.
    expect(lastCall!.init.headers['Content-Type']).toBeUndefined()
    expect(lastCall!.formData).toBeDefined()
  })

  test('sends the expected multipart fields', async () => {
    mockFetchJson({ text: 't' })
    const blob = new Blob([new Uint8Array([0])], { type: 'audio/wav' })

    await provider.transcribe({
      audio: blob,
      contentType: 'audio/wav',
      language: 'th',
      prompt: 'menu items',
      model: 'gpt-4o-transcribe',
      filename: 'voicenote.wav',
    })

    const form = lastCall!.formData!
    expect(form.get('model')).toBe('gpt-4o-transcribe')
    expect(form.get('response_format')).toBe('verbose_json')
    expect(form.get('language')).toBe('th')
    expect(form.get('prompt')).toBe('menu items')
    const file = form.get('file') as File
    expect(file).toBeInstanceOf(Blob)
    expect(file.name).toBe('voicenote.wav')
  })

  test('defaults model to whisper-1 and derives filename from contentType', async () => {
    mockFetchJson({ text: 't' })

    await provider.transcribe({
      audio: new Uint8Array([0]),
      contentType: 'audio/mpeg',
    })

    const form = lastCall!.formData!
    expect(form.get('model')).toBe('whisper-1')
    const file = form.get('file') as File
    expect(file.name).toBe('audio.mpeg')
  })

  test('returns the raw response on the result', async () => {
    mockFetchJson({ text: 'x', extra: { segments: [] } })

    const result = await provider.transcribe({ audio: new Uint8Array([0]) })
    expect((result.raw as any).extra.segments).toEqual([])
  })
})

describe('GoogleProvider.transcribe', () => {
  const provider = new GoogleProvider({
    driver: 'google',
    apiKey: 'test-google-key',
    model: 'gemini-2.5-flash',
    baseUrl: 'https://gen.test/v1beta',
    maxRetries: 0,
  })

  test('posts a generateContent call with inline_data audio + transcription prompt', async () => {
    mockFetchJson({
      candidates: [{ content: { parts: [{ text: 'สวัสดี' }] } }],
    })
    const bytes = new Uint8Array([10, 20, 30])

    const result = await provider.transcribe({
      audio: bytes,
      contentType: 'audio/m4a',
      language: 'th',
      prompt: 'Thai café menu',
    })

    expect(result.text).toBe('สวัสดี')
    expect(result.language).toBe('th')
    expect(lastCall!.url).toBe('https://gen.test/v1beta/models/gemini-2.5-flash:generateContent')
    expect(lastCall!.init.headers['x-goog-api-key']).toBe('test-google-key')
    const body = lastCall!.body
    expect(body.contents).toHaveLength(1)
    expect(body.contents[0].parts).toHaveLength(2)
    expect(body.contents[0].parts[1].inline_data.mime_type).toBe('audio/m4a')
    // Base64 of [10,20,30] is 'ChQe'
    expect(body.contents[0].parts[1].inline_data.data).toBe('ChQe')
    // Instruction carries the language + prompt hints
    expect(body.contents[0].parts[0].text).toContain('Thai café menu')
    expect(body.contents[0].parts[0].text).toContain('th')
    // Temperature 0 for deterministic transcription
    expect(body.generationConfig.temperature).toBe(0)
  })

  test('defaults model to gemini-2.5-flash when none supplied', async () => {
    mockFetchJson({ candidates: [{ content: { parts: [{ text: 'x' }] } }] })
    await provider.transcribe({ audio: new Uint8Array([0]) })
    expect(lastCall!.url).toContain('gemini-2.5-flash:generateContent')
  })

  test('honours an explicit model override', async () => {
    mockFetchJson({ candidates: [{ content: { parts: [{ text: 'x' }] } }] })
    await provider.transcribe({ audio: new Uint8Array([0]), model: 'gemini-2.5-pro' })
    expect(lastCall!.url).toContain('gemini-2.5-pro:generateContent')
  })
})

describe('BrainManager.transcribe', () => {
  afterEach(() => {
    BrainManager.reset()
  })

  test('dispatches to the named provider', async () => {
    mockFetchJson({ text: 'ok' })
    BrainManager.useProvider(
      new OpenAIProvider({
        driver: 'openai',
        apiKey: 'k',
        model: 'gpt-4o',
        baseUrl: 'https://api.openai.test',
        maxRetries: 0,
      })
    )

    const result = await BrainManager.transcribe('openai', { audio: new Uint8Array([0]) })
    expect(result.text).toBe('ok')
  })

  test('throws ConfigurationError when provider lacks transcribe()', async () => {
    BrainManager.useProvider(
      new AnthropicProvider({
        driver: 'anthropic',
        apiKey: 'k',
        model: 'claude-opus-4-7',
      })
    )

    await expect(
      BrainManager.transcribe('anthropic', { audio: new Uint8Array([0]) })
    ).rejects.toThrow('does not support transcribe')
  })
})
