# Spring Examples and Recipes

This guide provides practical examples and recipes for common patterns when building applications with **@strav/spring**.

## Complete Application Examples

### Blog Platform

A complete blog platform showcasing most Spring features:

```bash
# Create the application
bunx @strav/spring blog-platform --web --db=blog_db
cd blog-platform
```

#### 1. Schema Design

```typescript
// database/schemas/public/post.ts
export default defineSchema('post', {
  archetype: Archetype.Entity,
  fields: {
    id: t.uuid().primaryKey(),
    title: t.string().required().max(200),
    slug: t.string().unique().required(),
    excerpt: t.text().nullable(),
    content: t.text().required(),
    status: t.enum(['draft', 'published', 'scheduled']).default('draft'),
    featured_image: t.string().url().nullable(),
    published_at: t.timestamp().nullable(),
    author_id: t.reference('user'),
    category_id: t.reference('category').nullable(),
    view_count: t.integer().default(0),
    seo_title: t.string().nullable().max(60),
    seo_description: t.text().nullable().max(160),
  },
})

// database/schemas/public/category.ts
export default defineSchema('category', {
  archetype: Archetype.Reference,
  fields: {
    id: t.uuid().primaryKey(),
    name: t.string().unique().required(),
    slug: t.string().unique().required(),
    description: t.text().nullable(),
    color: t.string(7).nullable(), // Hex color
  },
})

// database/schemas/public/tag.ts
export default defineSchema('tag', {
  archetype: Archetype.Reference,
  fields: {
    id: t.uuid().primaryKey(),
    name: t.string().unique().required(),
    slug: t.string().unique().required(),
  },
})

// database/schemas/public/post_tag.ts (many-to-many)
export default defineAssociation(['post', 'tag'], {
  as: { post: 'tags', tag: 'posts' },
})

// database/schemas/public/comment.ts
export default defineSchema('comment', {
  archetype: Archetype.Contribution,
  parents: ['post'],
  fields: {
    content: t.text().required().min(5),
    author_name: t.string().required(),
    author_email: t.string().email().required(),
    author_website: t.string().url().nullable(),
    parent_id: t.reference('comment').nullable(),
    is_approved: t.boolean().default(false),
    ip_address: t.string().nullable(),
  },
})
```

#### 2. Controllers

```typescript
// app/controllers/blog_controller.ts
import type { Context } from '@strav/http'
import { Controller } from './controller.ts'
import Post from '../models/post.ts'
import Category from '../models/category.ts'

export default class BlogController extends Controller {
  async index(ctx: Context) {
    const { page = 1, category } = ctx.query

    let query = Post.query()
      .where('status', 'published')
      .where('published_at', '<=', new Date())
      .preload('author')
      .preload('category')
      .orderBy('published_at', 'DESC')

    if (category) {
      query = query.whereHas('category', (q) => q.where('slug', category))
    }

    const posts = await query.paginate(page, 10)
    const categories = await Category.all()

    return ctx.view('blog/index', {
      posts,
      categories,
      currentCategory: category,
      title: category ? `Posts in ${category}` : 'Blog'
    })
  }

  async show(ctx: Context) {
    const { slug } = ctx.params

    const post = await Post.query()
      .where('slug', slug)
      .where('status', 'published')
      .preload('author')
      .preload('category')
      .preload('tags')
      .preload('comments', (q) =>
        q.where('is_approved', true)
         .where('parent_id', null)
         .orderBy('created_at', 'ASC')
      )
      .first()

    if (!post) {
      return this.notFound(ctx, 'Post not found')
    }

    // Increment view count
    await post.merge({ view_count: post.view_count + 1 }).save()

    // Get related posts
    const relatedPosts = await Post.query()
      .where('id', '!=', post.id)
      .where('category_id', post.category_id)
      .where('status', 'published')
      .limit(3)
      .all()

    return ctx.view('blog/show', {
      post,
      relatedPosts,
      title: post.seo_title || post.title,
      description: post.seo_description || post.excerpt
    })
  }
}
```

#### 3. Vue Islands for Interactivity

```vue
<!-- resources/ts/islands/comment_section.vue -->
<template>
  <div class="comment-section">
    <h3>Comments ({{ comments.length }})</h3>

    <!-- Comment List -->
    <div class="comments">
      <comment-item
        v-for="comment in comments"
        :key="comment.id"
        :comment="comment"
        @reply="setReplyTo"
      />
    </div>

    <!-- Comment Form -->
    <comment-form
      :post-id="postId"
      :reply-to="replyTo"
      @submitted="handleCommentSubmitted"
      @cancel-reply="replyTo = null"
    />
  </div>
</template>

<script setup>
import { ref } from 'vue'
import CommentItem from '../components/comment_item.vue'
import CommentForm from '../components/comment_form.vue'

const props = defineProps({
  postId: { type: String, required: true },
  initialComments: { type: String, default: '[]' }
})

const comments = ref(JSON.parse(props.initialComments))
const replyTo = ref(null)

function setReplyTo(comment) {
  replyTo.value = comment
}

function handleCommentSubmitted(comment) {
  if (comment.parent_id) {
    // Handle reply logic
  } else {
    comments.value.push(comment)
  }
  replyTo.value = null
}
</script>
```

```vue
<!-- resources/ts/islands/reading_progress.vue -->
<template>
  <div class="reading-progress" :style="{ width: `${progress}%` }"></div>
</template>

<script setup>
import { ref, onMounted, onUnmounted } from 'vue'

const progress = ref(0)

function updateProgress() {
  const article = document.querySelector('article')
  if (!article) return

  const scrollTop = window.scrollY
  const docHeight = article.offsetHeight
  const winHeight = window.innerHeight
  const scrollPercent = scrollTop / (docHeight - winHeight)
  progress.value = Math.min(100, Math.max(0, scrollPercent * 100))
}

onMounted(() => {
  window.addEventListener('scroll', updateProgress)
  updateProgress()
})

onUnmounted(() => {
  window.removeEventListener('scroll', updateProgress)
})
</script>

<style scoped>
.reading-progress {
  position: fixed;
  top: 0;
  left: 0;
  height: 3px;
  background: linear-gradient(90deg, #007bff, #00ff7b);
  z-index: 1000;
  transition: width 0.1s ease;
}
</style>
```

### E-commerce API

A headless e-commerce API with comprehensive features:

```bash
bunx @strav/spring ecommerce-api --api --db=shop_db
cd ecommerce-api
```

#### Schema Design

```typescript
// database/schemas/public/product.ts
export default defineSchema('product', {
  archetype: Archetype.Entity,
  fields: {
    id: t.uuid().primaryKey(),
    name: t.string().required().max(200),
    slug: t.string().unique().required(),
    description: t.text().required(),
    short_description: t.text().nullable().max(500),
    sku: t.string().unique().required(),
    price: t.decimal(10, 2).min(0).required(),
    compare_price: t.decimal(10, 2).min(0).nullable(),
    cost_price: t.decimal(10, 2).min(0).nullable(),
    stock_quantity: t.integer().min(0).default(0),
    track_inventory: t.boolean().default(true),
    weight: t.decimal(8, 3).nullable(),
    dimensions: t.jsonb().nullable(), // {length, width, height}
    images: t.jsonb().default('[]'), // Array of image URLs
    status: t.enum(['draft', 'active', 'archived']).default('draft'),
    seo_title: t.string().nullable().max(60),
    seo_description: t.text().nullable().max(160),
    category_id: t.reference('category').nullable(),
  },
})

// database/schemas/public/order.ts
export default defineSchema('order', {
  archetype: Archetype.Entity,
  fields: {
    id: t.uuid().primaryKey(),
    order_number: t.string().unique().required(),
    customer_id: t.reference('user'),
    status: t.enum([
      'pending',
      'confirmed',
      'processing',
      'shipped',
      'delivered',
      'cancelled',
      'refunded'
    ]).default('pending'),
    subtotal: t.decimal(10, 2).required(),
    tax_amount: t.decimal(10, 2).default(0),
    shipping_amount: t.decimal(10, 2).default(0),
    discount_amount: t.decimal(10, 2).default(0),
    total_amount: t.decimal(10, 2).required(),
    currency: t.string(3).default('USD'),
    shipping_address: t.jsonb().required(),
    billing_address: t.jsonb().required(),
    notes: t.text().nullable(),
    shipped_at: t.timestamp().nullable(),
    delivered_at: t.timestamp().nullable(),
  },
})

// database/schemas/public/order_item.ts
export default defineSchema('order_item', {
  archetype: Archetype.Component,
  parents: ['order'],
  fields: {
    product_id: t.reference('product'),
    product_variant_id: t.reference('product_variant').nullable(),
    quantity: t.integer().min(1).required(),
    unit_price: t.decimal(10, 2).required(),
    total_price: t.decimal(10, 2).required(),
    product_snapshot: t.jsonb().required(), // Product data at time of order
  },
})

// database/schemas/public/cart.ts
export default defineSchema('cart', {
  archetype: Archetype.Component,
  parents: ['user'],
  fields: {
    session_id: t.string().nullable(), // For guest carts
    expires_at: t.timestamp().nullable(),
  },
})

// database/schemas/public/cart_item.ts
export default defineSchema('cart_item', {
  archetype: Archetype.Component,
  parents: ['cart'],
  fields: {
    product_id: t.reference('product'),
    product_variant_id: t.reference('product_variant').nullable(),
    quantity: t.integer().min(1).required(),
  },
})
```

#### API Controllers

```typescript
// app/controllers/api/product_controller.ts
export default class ProductController extends Controller {
  async index(ctx: Context) {
    const {
      page = 1,
      limit = 20,
      category,
      min_price,
      max_price,
      search,
      sort = 'name'
    } = ctx.query

    let query = Product.query()
      .where('status', 'active')
      .preload('category')

    // Filters
    if (category) {
      query = query.whereHas('category', q => q.where('slug', category))
    }

    if (min_price) {
      query = query.where('price', '>=', parseFloat(min_price))
    }

    if (max_price) {
      query = query.where('price', '<=', parseFloat(max_price))
    }

    if (search) {
      query = query.where(q => {
        q.where('name', 'ILIKE', `%${search}%`)
         .orWhere('description', 'ILIKE', `%${search}%`)
         .orWhere('sku', 'ILIKE', `%${search}%`)
      })
    }

    // Sorting
    const sortMapping = {
      'name': ['name', 'ASC'],
      'price_low': ['price', 'ASC'],
      'price_high': ['price', 'DESC'],
      'newest': ['created_at', 'DESC']
    }

    const [sortField, sortDirection] = sortMapping[sort] || ['name', 'ASC']
    query = query.orderBy(sortField, sortDirection)

    const products = await query.paginate(page, Math.min(limit, 100))

    return this.respond(ctx, {
      products: products.data,
      pagination: products.pagination
    })
  }

  async show(ctx: Context) {
    const { slug } = ctx.params

    const product = await Product.query()
      .where('slug', slug)
      .where('status', 'active')
      .preload('category')
      .preload('variants')
      .first()

    if (!product) {
      return this.notFound(ctx, 'Product not found')
    }

    // Get related products
    const relatedProducts = await Product.query()
      .where('id', '!=', product.id)
      .where('category_id', product.category_id)
      .where('status', 'active')
      .limit(4)
      .all()

    return this.respond(ctx, {
      product,
      related_products: relatedProducts
    })
  }
}

// app/controllers/api/cart_controller.ts
export default class CartController extends Controller {
  async show(ctx: Context) {
    const user = ctx.auth.user
    const cart = await this.getOrCreateCart(user, ctx.session)

    const cartWithItems = await Cart.query()
      .where('id', cart.id)
      .preload('items', q =>
        q.preload('product')
         .preload('productVariant')
      )
      .first()

    const total = cartWithItems.items.reduce((sum, item) => {
      const price = item.productVariant?.price || item.product.price
      return sum + (price * item.quantity)
    }, 0)

    return this.respond(ctx, {
      cart: cartWithItems,
      item_count: cartWithItems.items.length,
      total_amount: total
    })
  }

  async addItem(ctx: Context) {
    const { product_id, product_variant_id, quantity = 1 } = await ctx.request.json()

    if (!product_id || quantity < 1) {
      return this.error(ctx, 'Invalid product or quantity')
    }

    const user = ctx.auth.user
    const cart = await this.getOrCreateCart(user, ctx.session)

    // Check if item already exists
    let cartItem = await CartItem.query()
      .where('cart_id', cart.id)
      .where('product_id', product_id)
      .where('product_variant_id', product_variant_id || null)
      .first()

    if (cartItem) {
      // Update quantity
      cartItem.quantity += quantity
      await cartItem.save()
    } else {
      // Create new item
      cartItem = await CartItem.create({
        cart_id: cart.id,
        product_id,
        product_variant_id,
        quantity
      })
    }

    return this.respond(ctx, { cart_item: cartItem }, 201)
  }

  private async getOrCreateCart(user, session) {
    if (user) {
      let cart = await Cart.query().where('user_id', user.id).first()
      if (!cart) {
        cart = await Cart.create({ user_id: user.id })
      }
      return cart
    } else {
      // Guest cart using session
      const sessionId = session.get('cart_session_id') || crypto.randomUUID()
      session.put('cart_session_id', sessionId)

      let cart = await Cart.query().where('session_id', sessionId).first()
      if (!cart) {
        cart = await Cart.create({
          session_id: sessionId,
          expires_at: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) // 30 days
        })
      }
      return cart
    }
  }
}
```

### Task Management System

A comprehensive task management API with real-time features:

```typescript
// database/schemas/public/workspace.ts
export default defineSchema('workspace', {
  archetype: Archetype.Entity,
  fields: {
    id: t.uuid().primaryKey(),
    name: t.string().required().max(100),
    slug: t.string().unique().required(),
    description: t.text().nullable(),
    settings: t.jsonb().default('{}'),
    owner_id: t.reference('user'),
  },
})

// database/schemas/public/project.ts
export default defineSchema('project', {
  archetype: Archetype.Component,
  parents: ['workspace'],
  fields: {
    name: t.string().required().max(100),
    description: t.text().nullable(),
    status: t.enum(['planning', 'active', 'paused', 'completed', 'archived']).default('planning'),
    start_date: t.date().nullable(),
    due_date: t.date().nullable(),
    color: t.string(7).nullable(), // Hex color
    settings: t.jsonb().default('{}'),
  },
})

// database/schemas/public/task.ts
export default defineSchema('task', {
  archetype: Archetype.Component,
  parents: ['project'],
  fields: {
    title: t.string().required().max(200),
    description: t.text().nullable(),
    status: t.enum(['todo', 'in_progress', 'review', 'done']).default('todo'),
    priority: t.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
    assignee_id: t.reference('user').nullable(),
    reporter_id: t.reference('user'),
    due_date: t.timestamp().nullable(),
    estimated_hours: t.decimal(5, 2).nullable(),
    actual_hours: t.decimal(5, 2).nullable(),
    tags: t.array('string').default('[]'),
    position: t.integer().default(0), // For ordering
  },
})

// Vue Island for Task Board
<!-- resources/ts/islands/task_board.vue -->
<template>
  <div class="task-board">
    <div class="board-header">
      <h2>{{ project.name }}</h2>
      <button @click="showAddTask = true" class="btn-primary">
        Add Task
      </button>
    </div>

    <div class="board-columns">
      <div
        v-for="status in statuses"
        :key="status.value"
        class="column"
        @drop="onDrop($event, status.value)"
        @dragover="onDragOver"
      >
        <div class="column-header">
          <h3>{{ status.label }}</h3>
          <span class="task-count">{{ getTasksByStatus(status.value).length }}</span>
        </div>

        <div class="tasks">
          <task-card
            v-for="task in getTasksByStatus(status.value)"
            :key="task.id"
            :task="task"
            @update="updateTask"
            @delete="deleteTask"
            draggable="true"
            @dragstart="onDragStart($event, task)"
          />
        </div>
      </div>
    </div>

    <!-- Add Task Modal -->
    <task-form-modal
      v-if="showAddTask"
      :project-id="project.id"
      @saved="handleTaskSaved"
      @cancel="showAddTask = false"
    />
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import TaskCard from '../components/task_card.vue'
import TaskFormModal from '../components/task_form_modal.vue'

const props = defineProps({
  project: { type: Object, required: true },
  initialTasks: { type: String, default: '[]' }
})

const tasks = ref(JSON.parse(props.initialTasks))
const showAddTask = ref(false)
const draggedTask = ref(null)

const statuses = [
  { value: 'todo', label: 'To Do' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'review', label: 'Review' },
  { value: 'done', label: 'Done' }
]

const getTasksByStatus = (status) => {
  return tasks.value
    .filter(task => task.status === status)
    .sort((a, b) => a.position - b.position)
}

function onDragStart(event, task) {
  draggedTask.value = task
  event.dataTransfer.effectAllowed = 'move'
}

function onDragOver(event) {
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
}

async function onDrop(event, newStatus) {
  event.preventDefault()

  if (!draggedTask.value || draggedTask.value.status === newStatus) {
    return
  }

  try {
    const response = await fetch(`/api/tasks/${draggedTask.value.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: newStatus })
    })

    if (response.ok) {
      const updatedTask = await response.json()
      updateTaskInList(updatedTask)
    }
  } catch (error) {
    console.error('Failed to update task:', error)
  }

  draggedTask.value = null
}

function updateTaskInList(updatedTask) {
  const index = tasks.value.findIndex(t => t.id === updatedTask.id)
  if (index !== -1) {
    tasks.value[index] = updatedTask
  }
}

function handleTaskSaved(task) {
  tasks.value.push(task)
  showAddTask.value = false
}

async function updateTask(task, changes) {
  try {
    const response = await fetch(`/api/tasks/${task.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(changes)
    })

    if (response.ok) {
      const updatedTask = await response.json()
      updateTaskInList(updatedTask)
    }
  } catch (error) {
    console.error('Failed to update task:', error)
  }
}

async function deleteTask(task) {
  if (!confirm('Delete this task?')) return

  try {
    const response = await fetch(`/api/tasks/${task.id}`, {
      method: 'DELETE'
    })

    if (response.ok) {
      tasks.value = tasks.value.filter(t => t.id !== task.id)
    }
  } catch (error) {
    console.error('Failed to delete task:', error)
  }
}
</script>
```

## Common Patterns and Recipes

### Authentication & Authorization

```typescript
// app/middleware/auth_middleware.ts
import type { Context } from '@strav/http'
import jwt from 'jsonwebtoken'
import User from '../models/user.ts'

export async function authMiddleware(ctx: Context, next: () => Promise<void>) {
  const token = ctx.request.headers.get('Authorization')?.replace('Bearer ', '')

  if (!token) {
    return ctx.json({ error: 'Authentication required' }, 401)
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    const user = await User.find(payload.sub)

    if (!user) {
      return ctx.json({ error: 'Invalid token' }, 401)
    }

    ctx.auth = { user }
    return next()
  } catch (error) {
    return ctx.json({ error: 'Invalid token' }, 401)
  }
}

// app/policies/post_policy.ts
export class PostPolicy {
  view(user, post) {
    return post.status === 'published' || user?.id === post.author_id
  }

  update(user, post) {
    return user?.id === post.author_id || user?.role === 'admin'
  }

  delete(user, post) {
    return user?.id === post.author_id || user?.role === 'admin'
  }
}
```

### File Upload Handling

```typescript
// app/controllers/upload_controller.ts
export default class UploadController extends Controller {
  async upload(ctx: Context) {
    const formData = await ctx.request.formData()
    const file = formData.get('file') as File

    if (!file) {
      return this.error(ctx, 'No file provided')
    }

    // Validate file type and size
    const allowedTypes = ['image/jpeg', 'image/png', 'image/webp']
    if (!allowedTypes.includes(file.type)) {
      return this.error(ctx, 'Invalid file type')
    }

    if (file.size > 5 * 1024 * 1024) { // 5MB
      return this.error(ctx, 'File too large')
    }

    // Generate unique filename
    const ext = file.name.split('.').pop()
    const filename = `${crypto.randomUUID()}.${ext}`
    const uploadPath = `storage/uploads/${filename}`

    // Save file
    const buffer = await file.arrayBuffer()
    await Bun.write(uploadPath, buffer)

    return this.respond(ctx, {
      filename,
      url: `/uploads/${filename}`,
      size: file.size,
      type: file.type
    })
  }
}

// Vue island for file upload
<!-- resources/ts/islands/file_upload.vue -->
<template>
  <div class="file-upload">
    <div
      class="drop-zone"
      :class="{ 'drag-over': isDragOver }"
      @drop="handleDrop"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
      @click="openFileDialog"
    >
      <input
        ref="fileInput"
        type="file"
        multiple
        :accept="accept"
        @change="handleFileSelect"
        style="display: none"
      />

      <div v-if="files.length === 0" class="upload-prompt">
        <svg class="upload-icon" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
        </svg>
        <p>Drag and drop files here, or <span>click to browse</span></p>
      </div>

      <div v-else class="file-list">
        <div v-for="file in files" :key="file.id" class="file-item">
          <div class="file-info">
            <span class="file-name">{{ file.name }}</span>
            <span class="file-size">{{ formatFileSize(file.size) }}</span>
          </div>

          <div class="file-status">
            <div v-if="file.status === 'uploading'" class="progress">
              <div class="progress-bar" :style="{ width: `${file.progress}%` }"></div>
            </div>
            <span v-else-if="file.status === 'success'" class="success">✓</span>
            <span v-else-if="file.status === 'error'" class="error">✗</span>
          </div>

          <button @click="removeFile(file.id)" class="remove-btn">×</button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick } from 'vue'

const props = defineProps({
  accept: { type: String, default: 'image/*' },
  maxSize: { type: Number, default: 5 * 1024 * 1024 }, // 5MB
  multiple: { type: Boolean, default: true }
})

const emit = defineEmits(['uploaded', 'error'])

const fileInput = ref(null)
const files = ref([])
const isDragOver = ref(false)

function openFileDialog() {
  fileInput.value.click()
}

function handleFileSelect(event) {
  const selectedFiles = Array.from(event.target.files)
  processFiles(selectedFiles)
}

function handleDrop(event) {
  event.preventDefault()
  isDragOver.value = false

  const droppedFiles = Array.from(event.dataTransfer.files)
  processFiles(droppedFiles)
}

function handleDragOver(event) {
  event.preventDefault()
  isDragOver.value = true
}

function handleDragLeave() {
  isDragOver.value = false
}

function processFiles(fileList) {
  for (const file of fileList) {
    if (file.size > props.maxSize) {
      emit('error', `File ${file.name} is too large`)
      continue
    }

    const fileObj = {
      id: crypto.randomUUID(),
      name: file.name,
      size: file.size,
      file,
      status: 'pending',
      progress: 0
    }

    files.value.push(fileObj)
    uploadFile(fileObj)
  }
}

async function uploadFile(fileObj) {
  const formData = new FormData()
  formData.append('file', fileObj.file)

  fileObj.status = 'uploading'

  try {
    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData,
      onUploadProgress: (event) => {
        if (event.lengthComputable) {
          fileObj.progress = Math.round((event.loaded / event.total) * 100)
        }
      }
    })

    if (response.ok) {
      const result = await response.json()
      fileObj.status = 'success'
      fileObj.url = result.url
      emit('uploaded', result)
    } else {
      throw new Error('Upload failed')
    }
  } catch (error) {
    fileObj.status = 'error'
    emit('error', `Failed to upload ${fileObj.name}`)
  }
}

function removeFile(fileId) {
  files.value = files.value.filter(f => f.id !== fileId)
}

function formatFileSize(bytes) {
  if (bytes === 0) return '0 Bytes'
  const k = 1024
  const sizes = ['Bytes', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}
</script>
```

### Real-time Features with WebSockets

```typescript
// app/services/websocket_service.ts
export class WebSocketService {
  private connections = new Map<string, WebSocket>()

  addConnection(userId: string, ws: WebSocket) {
    this.connections.set(userId, ws)

    ws.onclose = () => {
      this.connections.delete(userId)
    }
  }

  broadcast(event: string, data: any, userIds?: string[]) {
    const message = JSON.stringify({ event, data })

    if (userIds) {
      // Send to specific users
      userIds.forEach(userId => {
        const ws = this.connections.get(userId)
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(message)
        }
      })
    } else {
      // Broadcast to all connected users
      this.connections.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(message)
        }
      })
    }
  }
}

// Usage in controller
export default class TaskController extends Controller {
  async update(ctx: Context) {
    const { id } = ctx.params
    const changes = await ctx.request.json()

    const task = await Task.find(id)
    if (!task) {
      return this.notFound(ctx, 'Task not found')
    }

    await task.merge(changes).save()

    // Notify team members about the update
    const teamMembers = await task.project.users.pluck('id')
    ctx.websocket.broadcast('task:updated', task, teamMembers)

    return this.respond(ctx, { task })
  }
}
```

### Search and Filtering

```typescript
// app/services/search_service.ts
export class SearchService {
  static async searchProducts(query: string, filters: any = {}) {
    let baseQuery = Product.query().where('status', 'active')

    // Text search
    if (query) {
      baseQuery = baseQuery.where(q => {
        q.where('name', 'ILIKE', `%${query}%`)
         .orWhere('description', 'ILIKE', `%${query}%`)
         .orWhere('sku', 'ILIKE', `%${query}%`)
      })
    }

    // Category filter
    if (filters.category_ids?.length) {
      baseQuery = baseQuery.whereIn('category_id', filters.category_ids)
    }

    // Price range
    if (filters.min_price) {
      baseQuery = baseQuery.where('price', '>=', filters.min_price)
    }
    if (filters.max_price) {
      baseQuery = baseQuery.where('price', '<=', filters.max_price)
    }

    // Availability
    if (filters.in_stock) {
      baseQuery = baseQuery.where('stock_quantity', '>', 0)
    }

    // Tags
    if (filters.tags?.length) {
      baseQuery = baseQuery.whereHas('tags', q => {
        q.whereIn('slug', filters.tags)
      })
    }

    return baseQuery
  }
}

// Vue island for advanced search
<!-- resources/ts/islands/product_search.vue -->
<template>
  <div class="product-search">
    <div class="search-form">
      <input
        v-model="searchQuery"
        type="text"
        placeholder="Search products..."
        @input="debounceSearch"
        class="search-input"
      />

      <div class="filters">
        <select v-model="filters.category_id" @change="performSearch">
          <option value="">All Categories</option>
          <option v-for="category in categories" :key="category.id" :value="category.id">
            {{ category.name }}
          </option>
        </select>

        <div class="price-range">
          <input
            v-model.number="filters.min_price"
            type="number"
            placeholder="Min price"
            @input="debounceSearch"
          />
          <input
            v-model.number="filters.max_price"
            type="number"
            placeholder="Max price"
            @input="debounceSearch"
          />
        </div>

        <label class="checkbox">
          <input
            v-model="filters.in_stock"
            type="checkbox"
            @change="performSearch"
          />
          In Stock Only
        </label>
      </div>
    </div>

    <div class="results">
      <div v-if="loading" class="loading">
        Searching...
      </div>

      <div v-else-if="results.length === 0" class="no-results">
        No products found
      </div>

      <div v-else class="product-grid">
        <product-card
          v-for="product in results"
          :key="product.id"
          :product="product"
        />
      </div>

      <div v-if="hasMore" class="load-more">
        <button @click="loadMore" :disabled="loadingMore">
          {{ loadingMore ? 'Loading...' : 'Load More' }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive, onMounted } from 'vue'
import { debounce } from 'lodash-es'

const props = defineProps({
  initialCategories: { type: String, default: '[]' }
})

const categories = ref(JSON.parse(props.initialCategories))
const searchQuery = ref('')
const loading = ref(false)
const loadingMore = ref(false)
const results = ref([])
const currentPage = ref(1)
const hasMore = ref(true)

const filters = reactive({
  category_id: '',
  min_price: null,
  max_price: null,
  in_stock: false
})

const debounceSearch = debounce(performSearch, 500)

onMounted(() => {
  performSearch()
})

async function performSearch(reset = true) {
  if (reset) {
    currentPage.value = 1
    results.value = []
    hasMore.value = true
  }

  loading.value = true

  try {
    const params = new URLSearchParams({
      page: currentPage.value,
      limit: 20,
      search: searchQuery.value,
      ...Object.fromEntries(
        Object.entries(filters).filter(([key, value]) => value !== null && value !== '')
      )
    })

    const response = await fetch(`/api/products/search?${params}`)
    const data = await response.json()

    if (reset) {
      results.value = data.products
    } else {
      results.value.push(...data.products)
    }

    hasMore.value = data.pagination.has_more_pages
  } catch (error) {
    console.error('Search failed:', error)
  }

  loading.value = false
}

async function loadMore() {
  if (loadingMore.value || !hasMore.value) return

  loadingMore.value = true
  currentPage.value++
  await performSearch(false)
  loadingMore.value = false
}
</script>
```

These examples demonstrate how Spring applications can handle complex real-world scenarios while maintaining clean, maintainable code and leveraging Strav's unique features like schema-driven development and Vue islands.