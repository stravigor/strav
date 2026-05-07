<script setup lang="ts">
interface Props {
  tokenField?: string
  refreshUrl?: string
}

const props = withDefaults(defineProps<Props>(), {
  tokenField: '_captcha',
  refreshUrl: '/__captcha/svg',
})

async function refresh() {
  const response = await fetch(props.refreshUrl, { headers: { Accept: 'image/svg+xml' } })
  if (!response.ok) return
  const newToken = response.headers.get('X-Captcha-Token')
  const svgBody = await response.text()

  // Find the SVG sibling — refresh button is a span inside the
  // `.captcha-svg` wrapper that also holds the SSR-rendered SVG.
  const root = document.querySelector('[data-vue="captcha/refresh"]')
  const wrapper = root?.parentElement
  const oldSvg = wrapper?.querySelector('svg')
  if (oldSvg) {
    const tmp = document.createElement('div')
    tmp.innerHTML = svgBody
    const newSvg = tmp.querySelector('svg')
    if (newSvg) oldSvg.replaceWith(newSvg)
  }

  // Update the hidden token in the same <form>.
  if (newToken) {
    const form = wrapper?.closest('form')
    const input = form?.querySelector(`input[name="${props.tokenField}"]`)
    if (input instanceof HTMLInputElement) input.value = newToken
  }
}
</script>

<template>
  <button type="button" class="captcha-refresh" @click="refresh" aria-label="Refresh challenge">
    ↻
  </button>
</template>
