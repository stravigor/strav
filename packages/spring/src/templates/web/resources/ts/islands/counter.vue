<template>
  <div class="flex items-center space-x-4">
    <button
      @click="decrement"
      class="px-3 py-1 bg-red-500 text-white rounded hover:bg-red-600 transition-colors"
    >
      -
    </button>

    <span class="text-xl font-bold text-gray-900 min-w-[3rem] text-center">
      {{ count }}
    </span>

    <button
      @click="increment"
      class="px-3 py-1 bg-green-500 text-white rounded hover:bg-green-600 transition-colors"
    >
      +
    </button>

    <span class="text-sm text-gray-600 ml-4">{{ label }}</span>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const props = defineProps({
  initial: { type: Number, default: 0 },
  label: { type: String, default: 'Counter' }
})

const count = ref(props.initial)

function increment() {
  count.value++
}

function decrement() {
  count.value--
}
</script>