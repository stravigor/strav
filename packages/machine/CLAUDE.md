# @strav/machine

Declarative state machines for domain models — define states, transitions, guards, side effects, and events in a single definition. Use standalone or as an ORM mixin with auto-persistence via stateful().

## Dependencies
- @strav/kernel (peer)
- @strav/database (peer)

## Commands
- bun test
- bun run build

## Architecture
- src/machine.ts — state machine engine
- src/stateful.ts — ORM mixin for auto-persisted state machines
- src/types.ts — type definitions
- src/errors.ts — package-specific errors
- src/index.ts — public API

## Conventions
- State machines are defined declaratively as configuration objects
- Use stateful() mixin to bind a machine to an ORM model
- Guards run before transitions, side effects run after

## Audit hook

Every successful `apply()` emits a generic `machine:transition` event with `{ entity, field, from, to, transition }`. Apps wire it once to capture transitions across every machine without each definition declaring an `events.*` entry:

```ts
import { Emitter } from '@strav/kernel'
import { audit } from '@strav/audit'

Emitter.on('machine:transition', e => {
  audit.bySystem('machine')
    .on(e.entity?.constructor?.name ?? 'entity', String(e.entity?.id ?? ''))
    .action(e.transition)
    .diff({ [e.field]: e.from }, { [e.field]: e.to })
    .log()
})
```

The emit is zero-cost when no listener is registered (`Emitter.listenerCount` guard).
