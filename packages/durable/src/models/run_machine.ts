import { defineMachine } from '@strav/machine'

/**
 * The run-status lifecycle, modeled with `@strav/machine`.
 *
 *   pending → running ⇄ suspended
 *                running → completed
 *                running/suspended → compensating → failed
 *                any non-terminal → canceled
 *
 * The engine writes status columns via raw SQL inside its atomic, locked
 * transactions; this machine is the single declarative source of truth for
 * which transitions are legal and powers the `WorkflowRun` `stateful()` model.
 */
export const runMachine = defineMachine({
  field: 'status',
  initial: 'pending',
  states: [
    'pending',
    'running',
    'suspended',
    'compensating',
    'completed',
    'failed',
    'canceled',
  ],
  transitions: {
    begin: { from: 'pending', to: 'running' },
    suspend: { from: 'running', to: 'suspended' },
    wake: { from: 'suspended', to: 'running' },
    complete: { from: 'running', to: 'completed' },
    rollback: { from: ['running', 'suspended'], to: 'compensating' },
    fail: { from: ['running', 'suspended', 'compensating'], to: 'failed' },
    cancel: {
      from: ['pending', 'running', 'suspended', 'compensating'],
      to: 'canceled',
    },
  },
})
