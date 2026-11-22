import type { AgentHandle } from '../run.js';

/**
 * MCP-style tool: a name plus a JSON-object argument bag, returning a result.
 * This is deliberately framework-agnostic so it can wrap a real MCP client or
 * a plain in-process function with the same shape.
 */
export interface McpStyleTool {
  name: string;
  description?: string;
  execute: (args: Record<string, unknown>) => unknown;
}

export interface InstrumentedMcpTools {
  tools: McpStyleTool[];
  call(name: string, args?: Record<string, unknown>, callId?: string): Promise<unknown>;
}

/** Wrap MCP-style tools so every call becomes a child tool span of the agent. */
export function instrumentMcpTools(
  agent: AgentHandle,
  tools: McpStyleTool[],
): InstrumentedMcpTools {
  return {
    tools,
    async call(
      name: string,
      args: Record<string, unknown> = {},
      callId?: string,
    ): Promise<unknown> {
      const tool = tools.find((item) => item.name === name);
      const options: { name: string; callId?: string; arguments: Record<string, unknown> } = {
        name,
        arguments: args,
      };
      if (callId !== undefined) {
        options.callId = callId;
      }
      const handle = agent.startToolCall(options);
      if (!tool) {
        handle.end({ status: 'ERROR', errorMessage: `Unknown MCP tool: ${name}` });
        throw new Error(`Unknown MCP tool: ${name}`);
      }
      try {
        const result = await tool.execute(args);
        handle.end({ result });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        handle.end({ status: 'ERROR', errorMessage: message });
        throw error;
      }
    },
  };
}
