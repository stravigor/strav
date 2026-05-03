# Machine

Declarative state machines for domain models. Define states, transitions, guards, side effects, and events in a single definition. Use standalone on plain objects or as an ORM mixin with auto-persistence.

## Installation

```bash
bun add @strav/machine
```

No service provider or configuration needed — `defineMachine()` returns a standalone utility object.

## Defining a machine

```typescript
import { defineMachine } from '@strav/machine'

const orderMachine = defineMachine({
  field: 'status',
  initial: 'pending',

  states: ['pending', 'processing', 'shipped', 'delivered', 'canceled', 'refunded'],

  transitions: {
    process: { from: 'pending', to: 'processing' },
    ship:    { from: 'processing', to: 'shipped' },
    deliver: { from: 'shipped', to: 'delivered' },
    cancel:  { from: ['pending', 'processing'], to: 'canceled' },
    refund:  { from: ['delivered', 'canceled'], to: 'refunded' },
  },
})
```

### Options

| Property | Type | Description |
|----------|------|-------------|
| `field` | `string` | The property on the entity that holds the state |
| `initial` | `string` | The initial state for new entities |
| `states` | `string[]` | All valid states |
| `transitions` | `Record<string, { from, to }>` | Named transitions with source and target states |
| `guards` | `Record<string, (entity) => boolean>` | Functions that must return `true` for the transition |
| `effects` | `Record<string, (entity, meta) => void>` | Side effects to run after mutating the field |
| `events` | `Record<string, string>` | Event names to emit via `Emitter` after a transition |

## Standalone usage

The machine works on any object with the configured field.

### Query state

```typescript
const order = { status: 'pending', id: 1 }

orderMachine.state(order)                 // 'pending'
orderMachine.is(order, 'pending')         // true
orderMachine.is(order, 'shipped')         // false
orderMachine.can(order, 'process')        // true
orderMachine.can(order, 'ship')           // false
orderMachine.availableTransitions(order)  // ['process', 'cancel']
```

### Apply transitions

```typescript
const meta = await orderMachine.apply(order, 'process')
// meta = { from: 'pending', to: 'processing', transition: 'process' }
// order.status === 'processing'
```

`apply()` mutates the field directly. In standalone mode, it does **not** persist — the caller is responsible for saving.

### Invalid transitions

```typescript
import { TransitionError } from '@strav/machine'

const order = { status: 'shipped' }

try {
  await orderMachine.apply(order, 'process')
} catch (err) {
  // TransitionError: Cannot apply transition "process" from state "shipped".
  //   Allowed from: [pending]
  err.transition    // 'process'
  err.currentState  // 'shipped'
  err.allowedFrom   // ['pending']
}
```

If the transition name doesn't exist in the machine definition at all:

```typescript
try {
  await orderMachine.apply(order, 'teleport')
} catch (err) {
  // TransitionError: Transition "teleport" is not defined.
  err.allowedFrom   // undefined
}
```

## Guards

Guards are functions that must return `true` for a transition to proceed. They run after validating the from-state.

```typescript
const orderMachine = defineMachine({
  field: 'status',
  initial: 'pending',
  states: ['pending', 'processing', 'shipped', 'delivered', 'canceled', 'refunded'],
  transitions: {
    process: { from: 'pending', to: 'processing' },
    cancel:  { from: ['pending', 'processing'], to: 'canceled' },
    refund:  { from: ['delivered', 'canceled'], to: 'refunded' },
  },
  guards: {
    cancel: (order) => !order.locked,
    refund: (order) => {
      const thirtyDays = 30 * 24 * 60 * 60 * 1000
      return Date.now() - order.deliveredAt.getTime() < thirtyDays
    },
  },
})
```

### Async guards

Guards can be async — useful for checking external state or database conditions:

```typescript
guards: {
  publish: async (article) => {
    const reviews = await Review.where('articleId', article.id).count()
    return reviews >= 2
  },
}
```

### Guard errors

```typescript
import { GuardError } from '@strav/machine'

try {
  await orderMachine.apply(order, 'cancel')
} catch (err) {
  // GuardError: Guard rejected transition "cancel" from state "pending".
  err.transition    // 'cancel'
  err.currentState  // 'pending'
}
```

The entity is **not mutated** when a guard rejects.

### Guards and `can()`

The `can()` method also evaluates the guard:

```typescript
order.locked = true
orderMachine.can(order, 'cancel')  // false (guard blocks it)
```

## Effects

Side effects run **after** the field is mutated but **before** persistence (in the ORM mixin). Use them for sending notifications, logging, or updating related data.

```typescript
const orderMachine = defineMachine({
  // ...states, transitions...
  effects: {
    ship: async (order, meta) => {
      await sendShippingEmail(order.email)
      await Slack.notify(`Order #${order.id} shipped`)
    },
    cancel: async (order, meta) => {
      await refundPayment(order.paymentId)
    },
  },
})
```

The `meta` parameter contains transition details:

```typescript
interface TransitionMeta {
  from: string       // Previous state
  to: string         // New state
  transition: string // Transition name
}
```

## Events

Map transitions to event names. Events are emitted via `Emitter` after the transition completes (after effects run).

```typescript
import Emitter from '@strav/kernel'

const orderMachine = defineMachine({
  // ...states, transitions...
  events: {
    ship:    'order:shipped',
    deliver: 'order:delivered',
    cancel:  'order:canceled',
  },
})

Emitter.on('order:shipped', ({ entity, from, to, transition }) => {
  console.log(`Order ${entity.id} shipped`)
})
```

Events are fire-and-forget — errors in listeners don't affect the transition.

### Generic `machine:transition` event

Every successful `apply()` also emits a generic `machine:transition` event with `{ entity, field, from, to, transition }` — independent of the per-transition `events.*` mapping. Use it to wire a single audit / observability hook that captures every transition across every machine in the app:

```typescript
import { Emitter } from '@strav/kernel'
import { audit } from '@strav/audit'

Emitter.on('machine:transition', e => {
  audit
    .bySystem('machine')
    .on(e.entity?.constructor?.name ?? 'entity', String(e.entity?.id ?? ''))
    .action(e.transition)
    .diff({ [e.field]: e.from }, { [e.field]: e.to })
    .log()
})
```

The emit is zero-cost when no listener is registered (`Emitter.listenerCount` guard).

## ORM mixin

The `stateful()` mixin adds state machine methods directly to a `BaseModel` subclass, with automatic persistence via `.save()`.

```typescript
import { BaseModel } from '@strav/database'
import { stateful } from '@strav/machine'

class Order extends stateful(BaseModel, orderMachine) {
  declare id: number
  declare status: string
  declare locked: boolean
}
```

### Instance methods

```typescript
const order = await Order.find(1)

order.is('pending')            // boolean
order.can('process')           // boolean | Promise<boolean>
order.availableTransitions()   // string[]

await order.transition('process')
// 1. Validates from-state
// 2. Runs guard
// 3. Mutates order.status = 'processing'
// 4. Runs effect
// 5. Calls order.save()
// 6. Emits event
```

### Query scope

Filter records by state:

```typescript
const pending = await Order.inState('pending').get()
const active = await Order.inState(['processing', 'shipped']).get()
```

### Composing with other mixins

Use `compose()` to combine `stateful()` with other mixins:

```typescript
import { compose } from '@strav/kernel'
import { searchable } from '@strav/search'

class Order extends compose(
  BaseModel,
  searchable,
  (m) => stateful(m, orderMachine),
) {
  // Has both search and state machine methods
}
```

## Execution order

When `apply()` or `transition()` is called:

1. **Validate from-state** — check that the current state is in the transition's `from` list
2. **Run guard** — if defined, must return `true` (sync or async)
3. **Mutate field** — `entity[field] = to`
4. **Run effect** — if defined, execute the side effect
5. **Save** — (mixin only) call `entity.save()`
6. **Emit event** — if configured, fire via `Emitter`

If any step fails, subsequent steps don't run. The field is only mutated if both validation and guard pass.

## Practical examples

### Content publishing

```typescript
const articleMachine = defineMachine({
  field: 'status',
  initial: 'draft',
  states: ['draft', 'review', 'published', 'archived'],
  transitions: {
    submit:  { from: 'draft', to: 'review' },
    approve: { from: 'review', to: 'published' },
    reject:  { from: 'review', to: 'draft' },
    archive: { from: 'published', to: 'archived' },
    restore: { from: 'archived', to: 'draft' },
  },
  guards: {
    submit: (article) => article.title.length > 0 && article.body.length > 100,
  },
  events: {
    approve: 'article:published',
    archive: 'article:archived',
  },
})
```

### Support tickets

```typescript
const ticketMachine = defineMachine({
  field: 'state',
  initial: 'open',
  states: ['open', 'in_progress', 'waiting', 'resolved', 'closed'],
  transitions: {
    assign:   { from: 'open', to: 'in_progress' },
    wait:     { from: 'in_progress', to: 'waiting' },
    resume:   { from: 'waiting', to: 'in_progress' },
    resolve:  { from: ['in_progress', 'waiting'], to: 'resolved' },
    close:    { from: 'resolved', to: 'closed' },
    reopen:   { from: ['resolved', 'closed'], to: 'open' },
  },
  effects: {
    assign: async (ticket) => {
      await notifyAgent(ticket.assigneeId)
    },
    resolve: async (ticket) => {
      await notifyCustomer(ticket.reporterId)
    },
  },
})
```

### Invoice lifecycle

```typescript
const invoiceMachine = defineMachine({
  field: 'status',
  initial: 'draft',
  states: ['draft', 'sent', 'paid', 'overdue', 'void'],
  transitions: {
    send:    { from: 'draft', to: 'sent' },
    pay:     { from: ['sent', 'overdue'], to: 'paid' },
    overdue: { from: 'sent', to: 'overdue' },
    void:    { from: ['draft', 'sent', 'overdue'], to: 'void' },
  },
  guards: {
    void: (invoice) => invoice.status !== 'paid',
  },
  events: {
    send: 'invoice:sent',
    pay:  'invoice:paid',
    void: 'invoice:voided',
  },
})
```

## API reference

### `defineMachine(definition)`

Create a `Machine` object from a definition. Returns:

| Method | Signature | Description |
|--------|-----------|-------------|
| `state(entity)` | `→ TState` | Get current state |
| `is(entity, state)` | `→ boolean` | Check if in a specific state |
| `can(entity, transition)` | `→ boolean \| Promise<boolean>` | Check if transition is valid + guard passes |
| `availableTransitions(entity)` | `→ TTransition[]` | List valid transitions from current state |
| `apply(entity, transition)` | `→ Promise<TransitionMeta>` | Apply transition (mutate, effect, emit) |
| `definition` | `MachineDefinition` | Access the original definition |

### `stateful(Base, machine)`

Mixin that adds state machine methods to a `BaseModel` subclass.

**Instance methods:** `is()`, `can()`, `availableTransitions()`, `transition()`

**Static methods:** `inState(state)`

### Error classes

- `TransitionError` — transition not valid from current state
- `GuardError` — guard rejected the transition
