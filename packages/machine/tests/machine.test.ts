import { test, expect, describe, beforeEach } from 'bun:test'
import { Emitter } from '@strav/kernel'
import { defineMachine } from '../src/machine.ts'
import { TransitionError, GuardError } from '../src/errors.ts'

// ── Test Machine ────────────────────────────────────────────────────────────

const orderMachine = defineMachine({
  field: 'status',
  initial: 'pending',
  states: ['pending', 'processing', 'shipped', 'delivered', 'canceled', 'refunded'],
  transitions: {
    process: { from: 'pending', to: 'processing' },
    ship: { from: 'processing', to: 'shipped' },
    deliver: { from: 'shipped', to: 'delivered' },
    cancel: { from: ['pending', 'processing'], to: 'canceled' },
    refund: { from: ['delivered', 'canceled'], to: 'refunded' },
  },
  guards: {
    refund: entity => entity.refundable === true,
  },
  effects: {
    ship: async (entity, meta) => {
      entity._shipped = true
      entity._shipMeta = meta
    },
  },
  events: {
    deliver: 'order:delivered',
    cancel: 'order:canceled',
  },
})

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeOrder(status = 'pending') {
  return { status, id: 1, refundable: true, _shipped: false, _shipMeta: null }
}

describe('defineMachine', () => {
  beforeEach(() => {
    Emitter.reset()
  })

  // ── state() ──────────────────────────────────────────────────────────

  test('state() returns current state', () => {
    const order = makeOrder('processing')
    expect(orderMachine.state(order)).toBe('processing')
  })

  // ── is() ─────────────────────────────────────────────────────────────

  test('is() returns true for matching state', () => {
    const order = makeOrder('pending')
    expect(orderMachine.is(order, 'pending')).toBe(true)
  })

  test('is() returns false for non-matching state', () => {
    const order = makeOrder('pending')
    expect(orderMachine.is(order, 'shipped')).toBe(false)
  })

  // ── can() ────────────────────────────────────────────────────────────

  test('can() returns true for valid transition', () => {
    const order = makeOrder('pending')
    expect(orderMachine.can(order, 'process')).toBe(true)
  })

  test('can() returns false for invalid from-state', () => {
    const order = makeOrder('shipped')
    expect(orderMachine.can(order, 'process')).toBe(false)
  })

  test('can() supports multi-from transitions', () => {
    expect(orderMachine.can(makeOrder('pending'), 'cancel')).toBe(true)
    expect(orderMachine.can(makeOrder('processing'), 'cancel')).toBe(true)
    expect(orderMachine.can(makeOrder('shipped'), 'cancel')).toBe(false)
  })

  test('can() respects guard returning false', () => {
    const order = makeOrder('delivered')
    order.refundable = false
    expect(orderMachine.can(order, 'refund')).toBe(false)
  })

  test('can() respects guard returning true', () => {
    const order = makeOrder('delivered')
    order.refundable = true
    expect(orderMachine.can(order, 'refund')).toBe(true)
  })

  // ── availableTransitions() ───────────────────────────────────────────

  test('availableTransitions() lists valid transitions from current state', () => {
    expect(orderMachine.availableTransitions(makeOrder('pending'))).toEqual(['process', 'cancel'])
    expect(orderMachine.availableTransitions(makeOrder('processing'))).toEqual(['ship', 'cancel'])
    expect(orderMachine.availableTransitions(makeOrder('shipped'))).toEqual(['deliver'])
    expect(orderMachine.availableTransitions(makeOrder('delivered'))).toEqual(['refund'])
    expect(orderMachine.availableTransitions(makeOrder('canceled'))).toEqual(['refund'])
    expect(orderMachine.availableTransitions(makeOrder('refunded'))).toEqual([])
  })

  // ── apply() ──────────────────────────────────────────────────────────

  test('apply() mutates the entity field', async () => {
    const order = makeOrder('pending')
    await orderMachine.apply(order, 'process')
    expect(order.status).toBe('processing')
  })

  test('apply() returns transition meta', async () => {
    const order = makeOrder('pending')
    const meta = await orderMachine.apply(order, 'process')
    expect(meta).toEqual({ from: 'pending', to: 'processing', transition: 'process' })
  })

  test('apply() throws TransitionError for invalid from-state', async () => {
    const order = makeOrder('shipped')
    try {
      await orderMachine.apply(order, 'process')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(TransitionError)
      const te = err as TransitionError
      expect(te.transition).toBe('process')
      expect(te.currentState).toBe('shipped')
      expect(te.allowedFrom).toEqual(['pending'])
    }
  })

  test('apply() throws GuardError when guard rejects', async () => {
    const order = makeOrder('delivered')
    order.refundable = false
    try {
      await orderMachine.apply(order, 'refund')
      expect.unreachable('should have thrown')
    } catch (err) {
      expect(err).toBeInstanceOf(GuardError)
      const ge = err as GuardError
      expect(ge.transition).toBe('refund')
      expect(ge.currentState).toBe('delivered')
    }
  })

  test('apply() does not mutate entity when guard rejects', async () => {
    const order = makeOrder('delivered')
    order.refundable = false
    try {
      await orderMachine.apply(order, 'refund')
    } catch {}
    expect(order.status).toBe('delivered')
  })

  test('apply() runs effect after mutating field', async () => {
    const order = makeOrder('processing')
    await orderMachine.apply(order, 'ship')
    expect(order._shipped).toBe(true)
    expect(order._shipMeta).toEqual({
      from: 'processing',
      to: 'shipped',
      transition: 'ship',
    })
    // Field is already mutated when effect runs
    expect(order.status).toBe('shipped')
  })

  test('apply() emits event when configured', async () => {
    const events: any[] = []
    Emitter.on('order:delivered', (payload: any) => {
      events.push(payload)
    })

    const order = makeOrder('shipped')
    await orderMachine.apply(order, 'deliver')

    // Give async emit a tick to fire
    await Bun.sleep(5)

    expect(events.length).toBe(1)
    expect(events[0].entity).toBe(order)
    expect(events[0].from).toBe('shipped')
    expect(events[0].to).toBe('delivered')
    expect(events[0].transition).toBe('deliver')
  })

  test('apply() does not emit when no event is configured', async () => {
    const events: any[] = []
    Emitter.on('order:shipped', (payload: any) => {
      events.push(payload)
    })

    const order = makeOrder('processing')
    await orderMachine.apply(order, 'ship')
    await Bun.sleep(5)

    // ship has no event configured
    expect(events.length).toBe(0)
  })

  test('apply() chains multiple transitions', async () => {
    const order = makeOrder('pending')
    await orderMachine.apply(order, 'process')
    await orderMachine.apply(order, 'ship')
    await orderMachine.apply(order, 'deliver')
    expect(order.status).toBe('delivered')
  })

  // ── Async Guards ─────────────────────────────────────────────────────

  test('supports async guards', async () => {
    const machine = defineMachine({
      field: 'status',
      initial: 'draft',
      states: ['draft', 'published'],
      transitions: {
        publish: { from: 'draft', to: 'published' },
      },
      guards: {
        publish: async entity => {
          await Bun.sleep(5)
          return entity.approved === true
        },
      },
    })

    const doc = { status: 'draft', approved: false }
    await expect(machine.apply(doc, 'publish')).rejects.toThrow(GuardError)

    doc.approved = true
    await machine.apply(doc, 'publish')
    expect(doc.status).toBe('published')
  })

  // ── Edge Cases ───────────────────────────────────────────────────────

  test('definition is accessible', () => {
    expect(orderMachine.definition.field).toBe('status')
    expect(orderMachine.definition.initial).toBe('pending')
    expect(orderMachine.definition.states).toContain('shipped')
  })

  test('machine works with any field name', async () => {
    const machine = defineMachine({
      field: 'phase',
      initial: 'alpha',
      states: ['alpha', 'beta', 'release'],
      transitions: {
        promote: { from: 'alpha', to: 'beta' },
        release: { from: 'beta', to: 'release' },
      },
    })

    const project = { phase: 'alpha' }
    await machine.apply(project, 'promote')
    expect(project.phase).toBe('beta')
  })

  test('emits machine:transition for every successful apply (audit hook)', async () => {
    Emitter.reset()
    const events: any[] = []
    Emitter.on('machine:transition', (e: any) => events.push(e))

    const order = { status: 'pending' as const }
    await orderMachine.apply(order, 'process')
    await orderMachine.apply(order, 'ship')

    expect(events).toHaveLength(2)
    expect(events[0]).toMatchObject({
      field: 'status',
      from: 'pending',
      to: 'processing',
      transition: 'process',
    })
    expect(events[1]).toMatchObject({
      field: 'status',
      from: 'processing',
      to: 'shipped',
      transition: 'ship',
    })
    // The full entity is included so audit hooks can serialize it
    expect(events[0].entity).toBe(order)
  })

  test('machine:transition is zero-cost when no listener is registered', async () => {
    Emitter.reset()
    // No listener — apply should not throw or emit synchronously.
    const order = { status: 'pending' as const }
    await orderMachine.apply(order, 'process')
    expect(order.status).toBe('processing')
  })
})
