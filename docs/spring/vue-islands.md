# Vue Islands in Spring

Vue Islands are Strav's unique approach to progressive enhancement, combining server-side rendering with client-side interactivity. Spring templates showcase this powerful architecture with complete examples and best practices.

## Overview

**Vue Islands** solve the traditional SSR vs SPA tradeoff by letting you:

- Render pages **server-side** with `.strav` templates (fast, SEO-friendly)
- Add **interactive components** exactly where needed (Vue islands)
- Maintain **progressive enhancement** - pages work without JavaScript
- Get **TypeScript safety** throughout the entire stack

Think of islands as "sprinkles of interactivity" on otherwise static pages.

## How It Works

### 1. Server-Side Template

```html
<!-- resources/views/pages/product.strav -->
@layout('layouts/app')

@section('content')
  <div class="product">
    <h1>{{ product.name }}</h1>
    <p>{{ product.description }}</p>

    {{-- Static content rendered server-side --}}
    <div class="price">${{ product.price }}</div>

    {{-- Interactive Vue island --}}
    <vue:add-to-cart
      :productId="{{ product.id }}"
      :price="{{ product.price }}"
      :inStock="{{ product.in_stock ? 'true' : 'false' }}"
    />

    {{-- Another island for reviews --}}
    <vue:review-form :productId="{{ product.id }}" />
  </div>
@end
```

### 2. Vue Island Component

```vue
<!-- resources/ts/islands/add_to_cart.vue -->
<template>
  <div class="add-to-cart">
    <div class="quantity-selector">
      <button @click="quantity--" :disabled="quantity <= 1">-</button>
      <span>{{ quantity }}</span>
      <button @click="quantity++" :disabled="quantity >= 10">+</button>
    </div>

    <button
      @click="addToCart"
      :disabled="!inStock || adding"
      class="add-button"
    >
      {{ adding ? 'Adding...' : `Add to Cart - $${totalPrice}` }}
    </button>

    <div v-if="added" class="success-message">
      Added {{ quantity }} item(s) to cart!
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'

const props = defineProps({
  productId: { type: String, required: true },
  price: { type: Number, required: true },
  inStock: { type: Boolean, default: false }
})

const quantity = ref(1)
const adding = ref(false)
const added = ref(false)

const totalPrice = computed(() => {
  return (props.price * quantity.value).toFixed(2)
})

async function addToCart() {
  adding.value = true

  try {
    const response = await fetch('/api/cart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        product_id: props.productId,
        quantity: quantity.value
      })
    })

    if (response.ok) {
      added.value = true
      setTimeout(() => added.value = false, 3000)
    }
  } catch (error) {
    console.error('Failed to add to cart:', error)
  }

  adding.value = false
}
</script>

<style scoped>
.add-to-cart {
  border: 1px solid #ddd;
  padding: 1rem;
  border-radius: 8px;
}

.quantity-selector {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 1rem;
}

.add-button {
  background: #007bff;
  color: white;
  border: none;
  padding: 0.75rem 1.5rem;
  border-radius: 4px;
  cursor: pointer;
}

.add-button:disabled {
  background: #ccc;
  cursor: not-allowed;
}
</style>
</script>
```

### 3. Generated HTML

The server renders this HTML:

```html
<div class="product">
  <h1>Amazing Widget</h1>
  <p>This widget will change your life!</p>
  <div class="price">$29.99</div>

  <!-- Vue island placeholder -->
  <div data-vue="add-to-cart" data-props='{"productId":"123","price":29.99,"inStock":true}'></div>

  <!-- Another island -->
  <div data-vue="review-form" data-props='{"productId":"123"}'></div>
</div>
```

### 4. Client-Side Hydration

The `islands.js` file contains all your Vue components and automatically hydrates the placeholders:

```javascript
// Auto-generated islands.js
import { createApp } from 'vue'
import AddToCart from './components/add_to_cart.vue'
import ReviewForm from './components/review_form.vue'

// Register all island components
const components = {
  'add-to-cart': AddToCart,
  'review-form': ReviewForm
}

// Find and hydrate all islands
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-vue]').forEach(element => {
    const componentName = element.getAttribute('data-vue')
    const props = JSON.parse(element.getAttribute('data-props') || '{}')
    const Component = components[componentName]

    if (Component) {
      createApp(Component, props).mount(element)
    }
  })
})
```

## Spring Examples

The Spring web template includes three demonstration islands:

### 1. Counter Island

A basic interactive component showing state management:

```vue
<!-- resources/ts/islands/counter.vue -->
<template>
  <div class="counter">
    <button @click="count--" class="btn-red">-</button>
    <span class="count">{{ count }}</span>
    <button @click="count++" class="btn-green">+</button>
    <span class="label">{{ label }}</span>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const props = defineProps({
  initial: { type: Number, default: 0 },
  label: { type: String, default: 'Counter' }
})

const count = ref(props.initial)
</script>
```

**Usage in templates:**
```html
<vue:counter :initial="5" label="Click me!" />
```

### 2. User Search Island

Demonstrates form handling and reactive data:

```vue
<!-- resources/ts/islands/user_search.vue -->
<template>
  <div class="search">
    <input
      v-model="searchTerm"
      :placeholder="placeholder"
      class="search-input"
    />

    <div v-if="searchTerm" class="results">
      <p v-if="searchResults.length === 0">No results found</p>
      <ul v-else>
        <li v-for="result in searchResults" :key="result">
          {{ result }}
        </li>
      </ul>
    </div>

    <p class="info">
      {{ searchTerm ? `Searching for "${searchTerm}"` : `Search ${userCount} users` }}
    </p>
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

  const mockResults = [
    'John Doe (john@example.com)',
    'Jane Smith (jane@example.com)',
    'Bob Johnson (bob@example.com)'
  ]

  return mockResults.filter(result =>
    result.toLowerCase().includes(searchTerm.value.toLowerCase())
  )
})

watch(searchTerm, (newTerm) => {
  if (newTerm) {
    console.log(`Searching for: ${newTerm}`)
  }
})
</script>
```

### 3. User Manager Island

Complex CRUD operations with loading states:

```vue
<!-- resources/ts/islands/user_manager.vue -->
<template>
  <div class="user-manager">
    <h3>Interactive User Management</h3>

    <div class="grid">
      <!-- Add User Form -->
      <div class="add-user">
        <h4>Add New User</h4>
        <form @submit.prevent="addUser">
          <input
            v-model="newUser.name"
            type="text"
            placeholder="Full Name"
            required
          />
          <input
            v-model="newUser.email"
            type="email"
            placeholder="Email"
            required
          />
          <button type="submit" :disabled="isLoading">
            {{ isLoading ? 'Adding...' : 'Add User' }}
          </button>
        </form>
      </div>

      <!-- Statistics -->
      <div class="stats">
        <h4>Statistics</h4>
        <div class="stat">
          <span>Total Users:</span>
          <strong>{{ users.length }}</strong>
        </div>
        <div class="stat">
          <span>Added:</span>
          <strong class="green">+{{ addedCount }}</strong>
        </div>
      </div>
    </div>

    <!-- Recent Users -->
    <div class="recent-users">
      <h4>Recent Users</h4>
      <div v-if="users.length === 0" class="empty">
        No users yet. Add one above!
      </div>
      <div v-else class="user-list">
        <div
          v-for="(user, index) in users.slice(-5).reverse()"
          :key="user.id"
          class="user-item"
        >
          <div class="user-info">
            <div class="name">{{ user.name }}</div>
            <div class="email">{{ user.email }}</div>
          </div>
          <span v-if="index === 0" class="badge">Latest</span>
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

const users = ref(JSON.parse(props.initialUsers))
const addedCount = ref(0)
const isLoading = ref(false)

const newUser = reactive({
  name: '',
  email: ''
})

async function addUser() {
  if (!newUser.name || !newUser.email) return

  isLoading.value = true

  // Simulate API call
  await new Promise(resolve => setTimeout(resolve, 500))

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
```

## Island Development Patterns

### 1. Component Communication

Islands can communicate through various methods:

**Custom Events:**
```vue
<!-- Child island -->
<template>
  <button @click="notifyParent">Click me</button>
</template>

<script setup>
const emit = defineEmits(['userAction'])

function notifyParent() {
  // Dispatch custom DOM event
  const event = new CustomEvent('user-action', {
    detail: { action: 'click', timestamp: Date.now() }
  })
  document.dispatchEvent(event)
}
</script>
```

**Shared State (Pinia):**
```vue
<!-- Install: bun add pinia -->
<script setup>
import { useUserStore } from '../stores/user'

const userStore = useUserStore()
</script>
```

### 2. API Integration

Islands commonly interact with your API:

```vue
<script setup>
import { ref, onMounted } from 'vue'

const data = ref([])
const loading = ref(true)

onMounted(async () => {
  try {
    const response = await fetch('/api/data')
    data.value = await response.json()
  } catch (error) {
    console.error('Failed to load data:', error)
  } finally {
    loading.value = false
  }
})

async function updateItem(id, changes) {
  try {
    await fetch(`/api/items/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes)
    })

    // Update local state
    const index = data.value.findIndex(item => item.id === id)
    if (index !== -1) {
      Object.assign(data.value[index], changes)
    }
  } catch (error) {
    console.error('Failed to update item:', error)
  }
}
</script>
```

### 3. Error Boundaries

Handle errors gracefully in islands:

```vue
<template>
  <div class="island">
    <div v-if="error" class="error-state">
      <p>Something went wrong: {{ error.message }}</p>
      <button @click="retry">Try Again</button>
    </div>

    <div v-else-if="loading" class="loading-state">
      Loading...
    </div>

    <div v-else class="content">
      <!-- Your component content -->
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, onErrorCaptured } from 'vue'

const loading = ref(true)
const error = ref(null)

onErrorCaptured((err) => {
  error.value = err
  loading.value = false
  return false // Prevent error propagation
})

async function loadData() {
  loading.value = true
  error.value = null

  try {
    // Load your data
  } catch (err) {
    error.value = err
  } finally {
    loading.value = false
  }
}

function retry() {
  loadData()
}

onMounted(loadData)
</script>
```

## Build Process

### Development Mode

In development, islands are automatically built and watched:

```typescript
// index.ts
if (process.env.NODE_ENV !== 'production') {
  const islands = new IslandBuilder({
    islandsDir: './resources/ts/islands',
    outDir: './public',
    outFile: 'islands.js',
  })

  await islands.build()
  islands.watch() // Rebuild on file changes
}
```

### Production Build

For production, build islands once:

```bash
# Manual build
bun strav build:islands

# Or automatically on server start
APP_ENV=production bun start
```

### Build Configuration

Customize the island builder:

```typescript
const islands = new IslandBuilder({
  islandsDir: './resources/ts/islands',     // Source directory
  outDir: './public',                       // Output directory
  outFile: 'islands.js',                   // Output filename
  minify: true,                             // Minify in production
  sourceMaps: false,                        // Generate source maps
})
```

## Template Integration

### Using Islands in Templates

```html
<!-- Basic usage -->
<vue:my-component />

<!-- With string props -->
<vue:my-component title="Hello World" />

<!-- With data binding -->
<vue:my-component :userId="{{ user.id }}" />

<!-- With JSON data -->
<vue:my-component :config="{{ JSON.stringify(config) }}" />

<!-- With boolean values -->
<vue:my-component :enabled="{{ user.is_admin ? 'true' : 'false' }}" />
```

### Props Serialization

Server data is automatically serialized to JSON:

```typescript
// In your controller
return ctx.view('page', {
  user: { id: 123, name: 'John' },
  settings: { theme: 'dark', notifications: true }
})
```

```html
<!-- In template -->
<vue:user-profile :user="{{ JSON.stringify(user) }}" />
<vue:settings-panel :settings="{{ JSON.stringify(settings) }}" />
```

### Including Islands Script

Always include the islands script in your layout:

```html
<!-- resources/views/layouts/app.strav -->
<!DOCTYPE html>
<html>
<head>
  <!-- Your head content -->
</head>
<body>
  @show('content')

  {{-- This loads all island components --}}
  @islands

  @stack('scripts')
</body>
</html>
```

## Best Practices

### 1. Keep Islands Focused

Each island should have a single responsibility:

```vue
<!-- ✅ Good: Focused component -->
<!-- shopping_cart_item.vue -->
<template>
  <div class="cart-item">
    <!-- Just handles one item -->
  </div>
</template>

<!-- ❌ Avoid: Doing too much -->
<!-- shopping_cart_and_user_profile_and_notifications.vue -->
```

### 2. Progressive Enhancement

Design islands to enhance, not replace, server functionality:

```html
<!-- Server-rendered form works without JS -->
<form action="/submit" method="POST">
  <input name="email" required />
  <button type="submit">Subscribe</button>
</form>

<!-- Island enhances with validation and AJAX -->
<vue:newsletter-form />
```

### 3. Handle Loading States

Always show feedback for async operations:

```vue
<template>
  <button @click="save" :disabled="saving">
    {{ saving ? 'Saving...' : 'Save' }}
  </button>
</template>
```

### 4. Type Safety with Props

Use TypeScript for prop definitions:

```vue
<script setup lang="ts">
interface User {
  id: string
  name: string
  email: string
}

const props = defineProps<{
  user: User
  editable?: boolean
}>()
</script>
```

### 5. Accessibility

Ensure islands are accessible:

```vue
<template>
  <button
    @click="toggle"
    :aria-expanded="isOpen"
    aria-controls="dropdown-menu"
  >
    Menu
  </button>

  <div
    id="dropdown-menu"
    v-show="isOpen"
    role="menu"
  >
    <!-- Menu items -->
  </div>
</template>
```

## Testing Islands

### Component Testing

```typescript
// tests/islands/counter.test.ts
import { mount } from '@vue/test-utils'
import { test, expect } from 'bun:test'
import Counter from '../../resources/ts/islands/counter.vue'

test('counter increments', async () => {
  const wrapper = mount(Counter, {
    props: { initial: 5 }
  })

  expect(wrapper.text()).toContain('5')

  await wrapper.find('button:last-child').trigger('click')
  expect(wrapper.text()).toContain('6')
})
```

### Integration Testing

```typescript
// tests/integration/pages.test.ts
import { test, expect } from 'bun:test'

test('home page renders with islands', async () => {
  const response = await fetch('http://localhost:3000/')
  const html = await response.text()

  expect(html).toContain('data-vue="counter"')
  expect(html).toContain('data-props=')
})
```

## Common Patterns

### 1. Data Tables

```vue
<!-- data_table.vue -->
<template>
  <div class="data-table">
    <input v-model="searchTerm" placeholder="Search..." />

    <table>
      <thead>
        <tr>
          <th @click="sort('name')">Name</th>
          <th @click="sort('email')">Email</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="item in filteredData" :key="item.id">
          <td>{{ item.name }}</td>
          <td>{{ item.email }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>
```

### 2. Modal Dialogs

```vue
<!-- modal.vue -->
<template>
  <teleport to="body">
    <div v-if="show" class="modal-overlay" @click="$emit('close')">
      <div class="modal" @click.stop>
        <slot />
      </div>
    </div>
  </teleport>
</template>
```

### 3. Form Wizards

```vue
<!-- form_wizard.vue -->
<template>
  <div class="wizard">
    <div class="steps">
      <div v-for="(step, index) in steps" :key="index"
           :class="{ active: index === currentStep }">
        {{ step.title }}
      </div>
    </div>

    <component :is="steps[currentStep].component" />

    <div class="navigation">
      <button @click="prev" :disabled="currentStep === 0">
        Previous
      </button>
      <button @click="next" :disabled="currentStep === steps.length - 1">
        Next
      </button>
    </div>
  </div>
</template>
```

Vue Islands in Spring provide the perfect balance between server-side performance and client-side interactivity, making it easy to build modern web applications that are both fast and engaging.