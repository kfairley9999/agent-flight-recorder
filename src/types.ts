/**
 * Agent Flight Recorder trace format v0.1.
 *
 * Spans, events, and links follow OpenTelemetry conventions (IDs, Unix-nano
 * timestamps, status codes, attribute value types). Semantic attributes use
 * both the `gen_ai.*` conventions where they apply and `afr.*` extensions
 * documented in DESIGN.md.
 */

export const SCHEMA_VERSION = '0.1.0' as const;
export const SDK_NAME = 'agent-flight-recorder';
export const SDK_VERSION = '0.1.0';

export type AttributeValue = string | number | boolean | string[] | number[] | boolean[];

export type AttributeMap = Record<string, AttributeValue>;

export type SpanStatusCode = 'UNSET' | 'OK' | 'ERROR';

export type SpanKind = 'internal' | 'client' | 'server' | 'producer' | 'consumer';

export type AfrSpanType = 'run' | 'agent' | 'llm' | 'tool' | 'decision' | 'handoff';

export type MessageRole = 'system' | 'user' | 'assistant' | 'tool' | 'developer';

export type LinkType = 'handoff' | 'caused_by' | 'uses_result' | 'parent_run' | 'follows';

export interface SpanStatus {
  code: SpanStatusCode;
  message?: string;
}

export interface SpanEvent {
  name: string;
  timeUnixNano: string;
  attributes?: AttributeMap;
}

export interface SpanLink {
  traceId: string;
  spanId: string;
  attributes?: AttributeMap;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  status: SpanStatus;
  attributes: AttributeMap;
  events: SpanEvent[];
  links: SpanLink[];
}

export interface TraceResource {
  attributes: AttributeMap;
}

export interface TraceRedactionReport {
  applied: boolean;
  rulesTriggered: string[];
  redactedCount: number;
}

export interface TraceRun {
  id: string;
  name: string;
  startedAt: string;
  endedAt?: string;
  status: SpanStatusCode;
}

export interface Trace {
  schemaVersion: typeof SCHEMA_VERSION;
  resource: TraceResource;
  run: TraceRun;
  spans: Span[];
  redaction: TraceRedactionReport;
}

export interface MessageInput {
  role: MessageRole;
  content: string;
  id?: string;
  toolCallId?: string;
  name?: string;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface StartAgentOptions {
  id: string;
  role: string;
  name?: string;
  parentSpanId?: string;
  attributes?: AttributeMap;
}

export interface StartLlmOptions {
  model: string;
  provider?: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  name?: string;
  attributes?: AttributeMap;
}

export interface StartToolOptions {
  name: string;
  callId?: string;
  arguments?: unknown;
  attributes?: AttributeMap;
}

export interface DecisionInput {
  type: string;
  summary: string;
  data?: unknown;
  attributes?: AttributeMap;
}

export interface LlmEndOptions {
  output?: string;
  finishReason?: string;
  usage?: LlmUsage;
  status?: SpanStatusCode;
  errorMessage?: string;
}

export interface ToolEndOptions {
  result?: unknown;
  status?: SpanStatusCode;
  errorMessage?: string;
}

export const ATTR = {
  spanType: 'afr.span.type',
  stepIndex: 'afr.step.index',
  agentId: 'afr.agent.id',
  agentRole: 'afr.agent.role',
  agentAttempt: 'afr.agent.attempt',
  toolName: 'afr.tool.name',
  toolCallId: 'afr.tool.call_id',
  toolArguments: 'afr.tool.arguments',
  toolResult: 'afr.tool.result',
  decisionType: 'afr.decision.type',
  decisionSummary: 'afr.decision.summary',
  decisionData: 'afr.decision.data',
  messageRole: 'afr.message.role',
  messageContent: 'afr.message.content',
  messageId: 'afr.message.id',
  messageToolCallId: 'afr.message.tool_call_id',
  messageName: 'afr.message.name',
  linkType: 'afr.link.type',
  outputHash: 'afr.output.hash',
  argumentHash: 'afr.argument.hash',
  genAiSystem: 'gen_ai.system',
  genAiModel: 'gen_ai.request.model',
  genAiTemperature: 'gen_ai.request.temperature',
  genAiMaxTokens: 'gen_ai.request.max_tokens',
  genAiTopP: 'gen_ai.request.top_p',
  genAiFinishReason: 'gen_ai.response.finish_reason',
  genAiInputTokens: 'gen_ai.usage.input_tokens',
  genAiOutputTokens: 'gen_ai.usage.output_tokens',
  genAiOutput: 'gen_ai.response.output',
} as const;

export const EVENT = {
  message: 'afr.message',
  toolResult: 'afr.tool.result',
  decision: 'afr.decision',
  exception: 'exception',
} as const;
