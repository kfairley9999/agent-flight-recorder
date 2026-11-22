import type { AgentHandle, RunSession } from '../run.js';
import type { LiveModel, LiveModelRequest, LiveModelResponse } from '../replay.js';
import type { MessageInput, MessageRole } from '../types.js';

export interface ToolDefinition {
  name: string;
  description?: string;
  handler: (args: Record<string, unknown>) => unknown;
}

export interface ToolCallRequest {
  name: string;
  arguments?: Record<string, unknown>;
  callId?: string;
}

export interface LoopModelTurn {
  assistant?: string;
  toolCalls?: ToolCallRequest[];
  finishReason?: 'stop' | 'tool_calls' | 'error';
}

export type LoopModel = (
  request: LiveModelRequest & { tools: Array<{ name: string; description?: string }> },
) => Promise<LoopModelTurn> | LoopModelTurn;

export interface ToolLoopOptions {
  run: RunSession;
  agent: AgentHandle;
  model: string;
  provider?: string;
  tools: ToolDefinition[];
  complete: LoopModel;
  maxTurns?: number;
}

export interface ToolLoopResult {
  messages: MessageInput[];
  finalText?: string;
  turns: number;
}

/**
 * A minimal tool-calling agent loop with recording built in.
 * Compatible with a plain function calling cycle and with MCP-style
 * { name, arguments } tools (see adapters/mcp.ts).
 */
export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const maxTurns = options.maxTurns ?? 8;
  const messages: MessageInput[] = options.agent.span.events
    .filter((event) => event.name === 'afr.message')
    .map((event) => {
      const message: MessageInput = {
        role: String(event.attributes?.['afr.message.role'] ?? 'user') as MessageRole,
        content: String(event.attributes?.['afr.message.content'] ?? ''),
      };
      const toolCallId = event.attributes?.['afr.message.tool_call_id'];
      const name = event.attributes?.['afr.message.name'];
      if (typeof toolCallId === 'string') {
        message.toolCallId = toolCallId;
      }
      if (typeof name === 'string') {
        message.name = name;
      }
      return message;
    });

  let finalText: string | undefined;
  let turns = 0;

  for (let turn = 0; turn < maxTurns; turn += 1) {
    turns += 1;
    const llmOptions: { model: string; provider?: string } = { model: options.model };
    if (options.provider !== undefined) {
      llmOptions.provider = options.provider;
    }
    const llm = options.agent.startLlmCall(llmOptions);
    for (const message of messages) {
      llm.addMessage(message);
    }
    const request: LiveModelRequest & { tools: Array<{ name: string; description?: string }> } = {
      model: options.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      agentId: options.agent.agentId,
      tools: options.tools.map((tool) => {
        const item: { name: string; description?: string } = { name: tool.name };
        if (tool.description !== undefined) {
          item.description = tool.description;
        }
        return item;
      }),
    };
    if (options.provider !== undefined) {
      request.provider = options.provider;
    }
    const turnResult = await options.complete(request);
    if (turnResult.assistant) {
      llm.addMessage({ role: 'assistant', content: turnResult.assistant });
      options.agent.addMessage({ role: 'assistant', content: turnResult.assistant });
      messages.push({ role: 'assistant', content: turnResult.assistant });
      finalText = turnResult.assistant;
    }
    llm.end({
      output:
        turnResult.assistant ?? (turnResult.toolCalls ? JSON.stringify(turnResult.toolCalls) : ''),
      finishReason:
        turnResult.finishReason ?? (turnResult.toolCalls?.length ? 'tool_calls' : 'stop'),
    });

    if (!turnResult.toolCalls?.length) {
      break;
    }

    for (const call of turnResult.toolCalls) {
      const def = options.tools.find((tool) => tool.name === call.name);
      const toolOptions: { name: string; callId?: string; arguments: Record<string, unknown> } = {
        name: call.name,
        arguments: call.arguments ?? {},
      };
      if (call.callId !== undefined) {
        toolOptions.callId = call.callId;
      }
      const handle = options.agent.startToolCall(toolOptions);
      if (!def) {
        handle.end({ status: 'ERROR', errorMessage: `Unknown tool: ${call.name}` });
        const content = `Unknown tool: ${call.name}`;
        const unknownMsg = toolMessage(call.name, content, call.callId);
        options.agent.addMessage(unknownMsg);
        messages.push(unknownMsg);
        continue;
      }
      try {
        const result = await def.handler(call.arguments ?? {});
        handle.end({ result });
        const content = typeof result === 'string' ? result : JSON.stringify(result);
        const toolMsg = toolMessage(call.name, content, call.callId);
        options.agent.addMessage(toolMsg);
        messages.push(toolMsg);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        handle.end({ status: 'ERROR', errorMessage: message });
        const errMsg = toolMessage(call.name, message, call.callId);
        options.agent.addMessage(errMsg);
        messages.push(errMsg);
      }
    }
  }

  const result: ToolLoopResult = { messages, turns };
  if (finalText !== undefined) {
    result.finalText = finalText;
  }
  return result;
}

function toolMessage(name: string, content: string, callId?: string): MessageInput {
  const message: MessageInput = { role: 'tool', content, name };
  if (callId !== undefined) {
    message.toolCallId = callId;
  }
  return message;
}

/** Adapt a simple text-in/text-out LiveModel to a loop model that never calls tools. */
export function textOnlyLoopModel(model: LiveModel): LoopModel {
  return async (request) => {
    const response: LiveModelResponse = await model(request);
    return { assistant: response.output, finishReason: 'stop' };
  };
}
