import { test, expect } from 'bun:test'

test('example test', () => {
  expect(1 + 1).toBe(2)
})

test('health endpoint returns ok', async () => {
  // TODO: Add integration tests for your routes
  // Use @strav/testing for HTTP testing helpers
  expect(true).toBe(true)
})