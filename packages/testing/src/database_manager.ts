import { app } from '@strav/kernel'
import { Database, BaseModel } from '@strav/database'

/**
 * Singleton database manager for test isolation
 *
 * Manages a shared database connection across multiple test files
 * while ensuring proper cleanup and preventing "Connection closed" errors.
 */
export class TestDatabaseManager {
  private static instance: TestDatabaseManager | null = null
  private database: Database | null = null
  private referenceCount = 0
  private isInitialized = false
  private closeTimeout: Timer | null = null
  private readonly CLOSE_DELAY_MS = 100 // Small delay to allow other test files to start

  private constructor() {
    // Private constructor for singleton pattern
  }

  /**
   * Get the singleton instance
   */
  static getInstance(): TestDatabaseManager {
    if (!TestDatabaseManager.instance) {
      TestDatabaseManager.instance = new TestDatabaseManager()
    }
    return TestDatabaseManager.instance
  }

  /**
   * Get a shared database instance
   * Increments reference count to track active users
   */
  async getDatabase(): Promise<Database> {
    this.referenceCount++

    // Cancel any pending close operation
    if (this.closeTimeout) {
      clearTimeout(this.closeTimeout)
      this.closeTimeout = null
    }

    if (!this.database || !this.isInitialized) {
      await this.initializeDatabase()
    }

    return this.database!
  }

  /**
   * Release the database reference
   * Decrements reference count and closes connection when no more users
   */
  async releaseDatabase(): Promise<void> {
    this.referenceCount--

    if (this.referenceCount <= 0 && this.database) {
      // Schedule database close with a small delay
      // This allows other test files to start and increment the reference count
      this.closeTimeout = setTimeout(async () => {
        if (this.referenceCount <= 0 && this.database) {
          await this.database.close()
          this.database = null
          this.isInitialized = false
          this.referenceCount = 0
        }
        this.closeTimeout = null
      }, this.CLOSE_DELAY_MS)
    }
  }

  /**
   * Initialize the shared database connection
   */
  private async initializeDatabase(): Promise<void> {
    if (this.isInitialized && this.database) {
      return
    }

    // Register database singleton if not already registered
    if (!app.has(Database)) {
      app.singleton(Database)
    }

    this.database = app.resolve(Database)
    await this.database.init()

    // Configure BaseModel with the shared database
    new BaseModel(this.database)

    this.isInitialized = true
  }

  /**
   * Get current reference count (for debugging)
   */
  getReferenceCount(): number {
    return this.referenceCount
  }

  /**
   * Force close the database connection (for cleanup)
   */
  async forceClose(): Promise<void> {
    if (this.database) {
      await this.database.close()
      this.database = null
      this.isInitialized = false
      this.referenceCount = 0
    }
  }
}

/**
 * Utility function to clean up database connections on process exit
 */
export function cleanupTestDatabase(): void {
  const manager = TestDatabaseManager.getInstance()

  process.on('SIGINT', async () => {
    await manager.forceClose()
    process.exit(0)
  })

  process.on('SIGTERM', async () => {
    await manager.forceClose()
    process.exit(0)
  })
}