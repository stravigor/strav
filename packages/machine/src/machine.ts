import { Emitter } from '@strav/kernel'
import type { MachineDefinition, Machine, TransitionMeta } from './types.ts'
import { TransitionError, GuardError } from './errors.ts'

/**
 * Define a state machine.
 *
 * Returns a `Machine` object that can validate and apply transitions to any entity.
 * The machine operates on a single field of the entity object.
 *
 * @example
 * const orderMachine = defineMachine({
 *   field: 'status',
 *   initial: 'pending',
 *   states: ['pending', 'processing', 'shipped', 'delivered', 'canceled'],
 *   transitions: {
 *     process: { from: 'pending', to: 'processing' },
 *     ship:    { from: 'processing', to: 'shipped' },
 *     deliver: { from: 'shipped', to: 'delivered' },
 *     cancel:  { from: ['pending', 'processing'], to: 'canceled' },
 *   },
 *   guards: {
 *     cancel: (order) => !order.locked,
 *   },
 *   effects: {
 *     ship: async (order) => await sendShippingNotification(order),
 *   },
 *   events: {
 *     ship:    'order:shipped',
 *     deliver: 'order:delivered',
 *   },
 * })
 */
export function defineMachine<TState extends string, TTransition extends string>(
  definition: MachineDefinition<TState, TTransition>
): Machine<TState, TTransition> {
  // Pre-compute normalized from-arrays for each transition
  const fromMap = new Map<TTransition, TState[]>()
  for (const [name, def] of Object.entries(definition.transitions) as [
    TTransition,
    { from: TState | TState[]; to: TState },
  ][]) {
    fromMap.set(name, Array.isArray(def.from) ? def.from : [def.from])
  }

  return {
    definition,

    state(entity: any): TState {
      return entity[definition.field] as TState
    },

    is(entity: any, state: TState): boolean {
      return entity[definition.field] === state
    },

    can(entity: any, transition: TTransition): boolean | Promise<boolean> {
      const currentState = entity[definition.field] as TState
      const allowed = fromMap.get(transition)
      if (!allowed || !allowed.includes(currentState)) return false

      const guard = definition.guards?.[transition]
      if (!guard) return true

      const result = guard(entity)
      // Support both sync and async guards
      if (typeof (result as any)?.then === 'function') {
        return result as Promise<boolean>
      }
      return result as boolean
    },

    availableTransitions(entity: any): TTransition[] {
      const currentState = entity[definition.field] as TState
      const available: TTransition[] = []

      for (const [name, fromStates] of fromMap) {
        if (fromStates.includes(currentState)) {
          available.push(name)
        }
      }

      return available
    },

    async apply(
      entity: any,
      transition: TTransition
    ): Promise<TransitionMeta<TState, TTransition>> {
      const currentState = entity[definition.field] as TState
      const transitionDef = definition.transitions[transition]
      if (!transitionDef) {
        throw new TransitionError(transition, currentState)
      }

      const allowed = fromMap.get(transition)!
      if (!allowed.includes(currentState)) {
        throw new TransitionError(transition, currentState, allowed)
      }

      // Run guard
      const guard = definition.guards?.[transition]
      if (guard) {
        const passed = await guard(entity)
        if (!passed) {
          throw new GuardError(transition, currentState)
        }
      }

      const meta: TransitionMeta<TState, TTransition> = {
        from: currentState,
        to: transitionDef.to,
        transition,
      }

      // Mutate field
      entity[definition.field] = transitionDef.to

      // Run effect
      const effect = definition.effects?.[transition]
      if (effect) {
        await effect(entity, meta)
      }

      // Emit user-defined per-transition event (zero-cost when no listener).
      const eventName = definition.events?.[transition]
      if (eventName && Emitter.listenerCount(eventName) > 0) {
        Emitter.emit(eventName, { entity, ...meta }).catch(() => {})
      }

      // Emit a generic state-transition event so a single audit hook can
      // observe every transition across every machine without each
      // definition wiring an `events.*` entry. Zero-cost when no
      // listener is registered.
      if (Emitter.listenerCount('machine:transition') > 0) {
        Emitter.emit('machine:transition', {
          entity,
          field: definition.field,
          ...meta,
        }).catch(() => {})
      }

      return meta
    },
  }
}
