<script setup lang="ts">
import { onMounted, ref } from 'vue'

interface Props {
  challenge: string
  difficulty: number
  tokenField?: string
  responseField?: string
}

const props = withDefaults(defineProps<Props>(), {
  tokenField: '_captcha',
  responseField: '_captcha_answer',
})

const status = ref<'idle' | 'solving' | 'solved' | 'error'>('idle')
const elapsedMs = ref(0)

onMounted(() => {
  void solve()
})

async function solve() {
  status.value = 'solving'
  const start = performance.now()

  try {
    const nonce = await findNonce(props.challenge, props.difficulty)
    elapsedMs.value = Math.round(performance.now() - start)
    writeAnswer(nonce)
    status.value = 'solved'
  } catch (err) {
    console.error('[captcha/pow] failed', err)
    status.value = 'error'
  }
}

/**
 * Find a nonce N such that sha256(challenge + ':' + N) has at least
 * `difficulty` leading zero bits. We try a counter — simple and easy to
 * verify on the server with the same construction.
 *
 * Yields back to the event loop every 256 attempts so the page stays
 * responsive on phones / weaker CPUs.
 */
async function findNonce(challenge: string, difficulty: number): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('Web Crypto API unavailable')
  }

  const encoder = new TextEncoder()
  let nonce = 0

  while (true) {
    for (let i = 0; i < 256; i++) {
      const candidate = String(nonce++)
      const buffer = await crypto.subtle.digest(
        'SHA-256',
        encoder.encode(challenge + ':' + candidate)
      )
      if (leadingZeroBits(new Uint8Array(buffer)) >= difficulty) {
        return candidate
      }
    }
    // Yield to keep the UI alive
    await new Promise(resolve => setTimeout(resolve, 0))
  }
}

function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i]!
    if (b === 0) {
      bits += 8
      continue
    }
    let n = b
    while ((n & 0x80) === 0) {
      bits++
      n <<= 1
    }
    break
  }
  return bits
}

/**
 * Write the nonce into the form's hidden answer field. We look up the
 * nearest enclosing form and find the input by name — robust against
 * forms that re-render or move the widget around.
 */
function writeAnswer(nonce: string) {
  const root = document.querySelector(`[data-vue="captcha/pow"]`)
  const form = root?.closest('form')
  if (!form) return
  const input = form.querySelector(`input[name="${props.responseField}"]`)
  if (input instanceof HTMLInputElement) input.value = nonce
}
</script>

<template>
  <div class="captcha-pow" :data-status="status">
    <span v-if="status === 'idle'" aria-hidden="true">⋯</span>
    <span v-else-if="status === 'solving'">Verifying you're human…</span>
    <span v-else-if="status === 'solved'" aria-live="polite">✓ Verified ({{ elapsedMs }}ms)</span>
    <span v-else class="captcha-pow-error">Verification failed</span>
  </div>
</template>
