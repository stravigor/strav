# @strav/flag

Feature flags with a unified API, scoped per-user or per-team, with optional rich values for A/B testing. Built-in drivers for PostgreSQL (persistent) and in-memory (testing).

## Dependencies
- @strav/kernel (peer)
- @strav/database (peer)
- @strav/http (peer)
- @strav/cli (peer)

## Commands
- bun test
- bun run build

## Architecture
- src/flag_manager.ts — main manager class
- src/flag_provider.ts — service provider registration
- src/feature_store.ts — feature flag storage
- src/pending_scope.ts — scoping logic
- src/drivers/ — storage backends (PostgreSQL, in-memory)
- src/commands/ — CLI commands
- src/middleware/ — HTTP middleware for flag evaluation
- src/types.ts — type definitions
- src/errors.ts — package-specific errors

## Conventions
- Drivers implement a common interface defined in types.ts
- Feature flags are scoped — always provide a scope context when evaluating

## Auditability of flag changes

`activate()`, `deactivate()`, `activateForEveryone()`, and `deactivateForEveryone()` accept an optional `actor: { type, id }` parameter. The actor is included in the `flag:updated` Emitter event payload alongside `previous` (the prior stored value) so a subscriber can record who flipped what. The flag package deliberately does NOT depend on `@strav/audit` — wiring is the consumer's choice; the recommended one-liner:

```ts
import { Emitter } from '@strav/kernel'
import { audit } from '@strav/audit'

Emitter.on('flag:updated', e => {
  if (!e.actor) return
  audit.by(e.actor)
    .on('feature_flag', e.feature)
    .action(e.value === false ? 'deactivated' : 'activated')
    .diff({ value: e.previous }, { value: e.value })
    .meta({ scope: e.scope })
    .log()
})
```

When `actor` is omitted the event still fires with `actor: null` — useful for system-driven flips that don't need attribution but should still emit `flag:updated`. Document this expectation in your app: any place in the codebase that calls `activate`/`deactivate` from a user-initiated request must pass the requesting actor.
