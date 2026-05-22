import { StravError } from '@strav/kernel'

/** Base error class for all MCP errors. */
export class McpError extends StravError {}

/** Thrown when a tool, resource, prompt, or task with the same name is registered twice. */
export class DuplicateRegistrationError extends McpError {
  constructor(type: 'tool' | 'resource' | 'prompt' | 'task', name: string) {
    super(`${type} "${name}" is already registered.`)
  }
}
