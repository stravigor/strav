// Manager
export { default, default as McpManager } from './mcp_manager.ts'

// Provider
export { default as McpProvider } from './mcp_provider.ts'
export type { McpProviderOptions } from './mcp_provider.ts'

// Helper
export { mcp } from './helpers.ts'

// Transports
export { serveStdio } from './transports/stdio.ts'
export { mountHttpTransport } from './transports/bun_http_transport.ts'
export type {
  WebStandardStreamableHTTPServerTransport,
  MountHttpOptions,
  EventStore,
} from './transports/bun_http_transport.ts'
export { MemoryEventStore } from './transports/memory_event_store.ts'
export type { MemoryEventStoreOptions } from './transports/memory_event_store.ts'

// Tasks
export { InMemoryTaskStore, InMemoryTaskMessageQueue, isTerminal } from './tasks.ts'
export type {
  TaskStore,
  TaskMessageQueue,
  CreateTaskOptions,
  Task,
  TaskSupport,
  TaskOptions,
  TaskRegistration,
} from './tasks.ts'

// Elicitation
export { confirmation, wasApproved } from './elicitation.ts'
export type {
  ElicitFn,
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
} from './elicitation.ts'

// Client
export { McpClient } from './client/mcp_client.ts'
export type { McpClientOptions, McpToolInfo } from './client/mcp_client.ts'

// Errors
export { McpError, DuplicateRegistrationError } from './errors.ts'

// Types
export type {
  McpConfig,
  ZodRawShape,
  InferShape,
  ToolHandlerContext,
  McpCallerToken,
  McpCallerClient,
  McpRequestInfo,
  ToolRegistration,
  ToolHandler,
  ResourceRegistration,
  ResourceHandler,
  PromptRegistration,
  PromptHandler,
  // Re-exported SDK result types
  CallToolResult,
  GetPromptResult,
  ReadResourceResult,
} from './types.ts'
