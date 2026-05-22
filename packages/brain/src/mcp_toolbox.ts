import { McpClient } from '@strav/mcp'
import type { McpClientOptions } from '@strav/mcp'
import type { ToolDefinition, JsonSchema } from './types.ts'

/** Options for {@link defineMcpToolbox}. */
export interface McpToolboxOptions extends McpClientOptions {
  /** Restrict the toolbox to these tool names. Default: every remote tool. */
  only?: string[]
}

/**
 * Build a brain toolbox backed by a remote MCP server.
 *
 * Connects an {@link McpClient}, lists the server's tools, and maps each one
 * to a brain `ToolDefinition` whose `execute` performs the remote call — so a
 * `brain` `Agent` calls remote MCP tools exactly as it calls native ones.
 *
 * This is async (it must `listTools()` first), so await it at setup time:
 *
 * @example
 * const gateway = await defineMcpToolbox('gateway', {
 *   url: 'https://gateway/mcp',
 *   bearerToken: projectToken,
 * })
 *
 * class BuilderAgent extends Agent {
 *   tools = gateway
 * }
 */
export async function defineMcpToolbox(
  name: string,
  options: McpToolboxOptions
): Promise<ToolDefinition[]> {
  const { only, ...clientOptions } = options

  const client = new McpClient({
    clientInfo: { name: `strav-brain:${name}`, version: '1.0.0' },
    ...clientOptions,
  })

  const tools = await client.listTools()
  const selected = only ? tools.filter(tool => only.includes(tool.name)) : tools

  return selected.map(tool => ({
    name: tool.name,
    description: tool.description ?? '',
    parameters: tool.inputSchema as JsonSchema,
    execute: async (args: Record<string, unknown>) => {
      const result = await client.callTool(tool.name, args)

      // Prefer structured output; otherwise join the text content blocks.
      if (result.structuredContent !== undefined) {
        return result.isError ? { error: result.structuredContent } : result.structuredContent
      }
      const text = (result.content ?? [])
        .map((block: any) => (block?.type === 'text' ? String(block.text ?? '') : ''))
        .filter(Boolean)
        .join('\n')
      return result.isError ? { error: text } : text
    },
  }))
}
