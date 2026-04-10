<template>
  <div class="bg-white p-6 rounded-lg shadow">
    <h3 class="text-lg font-semibold text-gray-900 mb-4">Interactive User Management</h3>

    <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
      <!-- Add User Form -->
      <div>
        <h4 class="font-medium text-gray-900 mb-3">Add New User</h4>
        <form @submit.prevent="addUser" class="space-y-3">
          <input
            v-model="newUser.name"
            type="text"
            placeholder="Full Name"
            required
            class="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
          />
          <input
            v-model="newUser.email"
            type="email"
            placeholder="Email Address"
            required
            class="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500"
          />
          <button
            type="submit"
            :disabled="isLoading"
            class="w-full px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
          >
            {{ isLoading ? 'Adding...' : 'Add User' }}
          </button>
        </form>
      </div>

      <!-- User Stats -->
      <div>
        <h4 class="font-medium text-gray-900 mb-3">Statistics</h4>
        <div class="space-y-2">
          <div class="flex justify-between">
            <span class="text-gray-600">Total Users:</span>
            <span class="font-semibold">{{ users.length }}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-600">Users Added:</span>
            <span class="font-semibold text-green-600">+{{ addedCount }}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-gray-600">Last Added:</span>
            <span class="text-sm text-gray-500">
              {{ lastAdded || 'None yet' }}
            </span>
          </div>
        </div>
      </div>
    </div>

    <!-- Recent Users List -->
    <div class="mt-6">
      <h4 class="font-medium text-gray-900 mb-3">Recent Users</h4>
      <div v-if="users.length === 0" class="text-center text-gray-500 py-8">
        No users yet. Add one above!
      </div>
      <div v-else class="space-y-2 max-h-48 overflow-y-auto">
        <div
          v-for="(user, index) in users.slice(-5).reverse()"
          :key="user.id || index"
          class="flex items-center justify-between p-3 bg-gray-50 rounded-md"
        >
          <div>
            <div class="font-medium text-gray-900">{{ user.name }}</div>
            <div class="text-sm text-gray-500">{{ user.email }}</div>
          </div>
          <span v-if="index === 0" class="text-xs bg-green-100 text-green-800 px-2 py-1 rounded">
            Latest
          </span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, computed } from 'vue'

const props = defineProps({
  initialUsers: { type: String, default: '[]' }
})

// Parse initial users from JSON string
const users = ref(JSON.parse(props.initialUsers))
const addedCount = ref(0)
const isLoading = ref(false)

const newUser = reactive({
  name: '',
  email: ''
})

const lastAdded = computed(() => {
  if (addedCount.value === 0) return null
  const latest = users.value[users.value.length - 1]
  return latest ? `${latest.name} (${latest.email})` : null
})

async function addUser() {
  if (!newUser.name || !newUser.email) return

  isLoading.value = true

  // Simulate API call
  await new Promise(resolve => setTimeout(resolve, 500))

  // Add the new user
  users.value.push({
    id: crypto.randomUUID(),
    name: newUser.name,
    email: newUser.email,
    created_at: new Date()
  })

  addedCount.value++

  // Reset form
  newUser.name = ''
  newUser.email = ''
  isLoading.value = false
}
</script>