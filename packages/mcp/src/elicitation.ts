import type {
  ElicitRequestFormParams,
  ElicitRequestURLParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'

/**
 * MCP **Elicitation** — a handler can, mid-call, ask the client to surface a
 * confirmation or an input form to a human and await the response.
 *
 * Available on `ToolHandlerContext.elicit` when the transport has a
 * server→client channel and the client advertised the `elicitation`
 * capability.
 */

export type { ElicitRequestFormParams, ElicitRequestURLParams, ElicitResult }

/** The `elicit` function on `ToolHandlerContext`. */
export type ElicitFn = (
  params: ElicitRequestFormParams | ElicitRequestURLParams
) => Promise<ElicitResult>

/**
 * Build the params for a yes/no human confirmation — the common
 * `ask-approval` escalation case. The client surfaces `message`; the human
 * accepts or declines. Inspect the outcome with {@link wasApproved}.
 *
 * @example
 * const answer = await ctx.elicit!(confirmation('Deploy to production?'))
 * if (!wasApproved(answer)) return { content: [{ type: 'text', text: 'Cancelled.' }] }
 */
export function confirmation(message: string): ElicitRequestFormParams {
  return {
    message,
    requestedSchema: { type: 'object', properties: {} },
  }
}

/** `true` when the human accepted the elicitation; `decline` / `cancel` → `false`. */
export function wasApproved(result: ElicitResult): boolean {
  return result.action === 'accept'
}
