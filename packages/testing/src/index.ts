export { TestCase } from './test_case.ts'
export type { TestCaseOptions } from './test_case.ts'
export { Factory } from './factory.ts'

// Database management
export { TestDatabaseManager, cleanupTestDatabase } from './database_manager.ts'

// Browser-driven testing (Playwright). Lazy-loads playwright-core only when
// BrowserTestCase / DemoFlow are actually instantiated.
export { BrowserTestCase, DemoFlow, runFresh } from './browser/index.ts'
export type {
  BrowserTestCaseOptions,
  BrowserName,
  MailMode,
  DemoFlowOptions,
  ServerHandle,
} from './browser/index.ts'
