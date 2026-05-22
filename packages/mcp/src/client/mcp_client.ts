import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type {
  CallToolResult,
  ElicitRequest,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'

/** A tool exposed by a remote MCP server. */
export interface McpToolInfo {
  name: string
  description?: string
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>
}

/** Options for {@link McpClient}. */
export interface McpClientOptions {
  /** Streamable-HTTP endpoint of the remote MCP server (e.g. `https://gateway/mcp`). */
  url: string | URL
  /** Bearer token sent as `Authorization: Bearer <token>` on every request. */
  bearerToken?: string
  /** Extra headers sent on every request. */
  headers?: Record<string, string>
  /** Client identity advertised to the server. */
  clientInfo?: { name: string; version: string }
  /**
   * Answer server-initiated elicitation requests (human-in-the-loop). When
   * provided, the client advertises the `elicitation` capability.
   */
  onElicit?: (params: ElicitRequest['params']) => ElicitResult | Promise<ElicitResult>
}

/**
 * A client for a remote MCP server over the Streamable-HTTP transport.
 *
 * Wraps the official SDK `Client` + `StreamableHTTPClientTransport` with a
 * small, Strav-shaped surface — connect, list tools, call tools — and a
 * built-in bearer-token path for talking to an OAuth-scoped MCP gateway.
 *
 * @example
 * const client = new McpClient({ url: 'https://gateway/mcp', bearerToken })
 * const tools = await client.listTools()
 * const result = await client.callTool('write-artifact', { path, body })
 */
export class McpClient {
  private readonly client: Client
  private readonly transport: StreamableHTTPClientTransport
  private connected = false

  constructor(options: McpClientOptions) {
    const url = typeof options.url === 'string' ? new URL(options.url) : options.url

    const headers: Record<string, string> = { ...options.headers }
    if (options.bearerToken) headers.Authorization = `Bearer ${options.bearerToken}`

    this.transport = new StreamableHTTPClientTransport(url, {
      requestInit: Object.keys(headers).length > 0 ? { headers } : undefined,
    })

    this.client = new Client(
      options.clientInfo ?? { name: '@strav/mcp', version: '1.0.0' },
      options.onElicit ? { capabilities: { elicitation: {} } } : undefined
    )

    if (options.onElicit) {
      const onElicit = options.onElicit
      this.client.setRequestHandler(ElicitRequestSchema, request => onElicit(request.params))
    }
  }

  /** Connect to the remote server. Idempotent — safe to call repeatedly. */
  async connect(): Promise<void> {
    if (this.connected) return
    await this.client.connect(this.transport)
    this.connected = true
  }

  /** List the tools the remote server exposes. Connects first if needed. */
  async listTools(): Promise<McpToolInfo[]> {
    await this.connect()
    const { tools } = await this.client.listTools()
    return tools.map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: (tool.inputSchema ?? { type: 'object', properties: {} }) as Record<
        string,
        unknown
      >,
    }))
  }

  /** Call a remote tool by name. Connects first if needed. */
  async callTool(
    name: string,
    args: Record<string, unknown> = {}
  ): Promise<CallToolResult> {
    await this.connect()
    return (await this.client.callTool({ name, arguments: args })) as CallToolResult
  }

  /** Close the connection. */
  async close(): Promise<void> {
    if (!this.connected) return
    await this.client.close()
    this.connected = false
  }

  /** The underlying SDK `Client`, for advanced operations. */
  get sdk(): Client {
    return this.client
  }
}
