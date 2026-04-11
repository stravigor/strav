<template>
  <div class="space-y-4">
    <div class="relative">
      <input
        v-model="searchTerm"
        type="text"
        :placeholder="placeholder"
        class="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
      />
      <div class="absolute inset-y-0 right-0 pr-3 flex items-center">
        <svg class="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
      </div>
    </div>

    <div class="text-sm text-gray-600">
      <span v-if="searchTerm">
        Searching for "{{ searchTerm }}"...
      </span>
      <span v-else>
        Search through {{ userCount }} users
      </span>
    </div>

    <div v-if="searchTerm && searchResults.length > 0" class="border rounded-lg p-4 bg-gray-50">
      <p class="text-sm font-medium text-gray-900 mb-2">Search Results:</p>
      <ul class="space-y-1">
        <li v-for="result in searchResults" :key="result" class="text-sm text-gray-700">
          • {{ result }}
        </li>
      </ul>
    </div>

    <div v-else-if="searchTerm" class="border rounded-lg p-4 bg-gray-50 text-center text-gray-500">
      No results found for "{{ searchTerm }}"
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'

const props = defineProps({
  placeholder: { type: String, default: 'Search...' },
  userCount: { type: Number, default: 0 }
})

const searchTerm = ref('')
const searchResults = computed(() => {
  if (!searchTerm.value) return []

  // Mock search results - in a real app, this would call an API
  const mockResults = [
    'John Doe (john@example.com)',
    'Jane Smith (jane@example.com)',
    'Bob Johnson (bob@example.com)'
  ]

  return mockResults.filter(result =>
    result.toLowerCase().includes(searchTerm.value.toLowerCase())
  )
})

// Demo of reactive watchers
watch(searchTerm, (newTerm) => {
  if (newTerm) {
    console.log(`Searching for: ${newTerm}`)
  }
})
</script>