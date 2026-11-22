import { FlightRecorder } from './recorder.js';
import { fnv1aHex, stableStringify } from './serialize.js';
import { MemoryTraceStore } from './store.js';
import {
  ATTR,
  type AttributeMap,
  type DecisionInput,
  type LlmEndOptions,
  type Span,
  type StartAgentOptions,
  type StartLlmOptions,
  type StartToolOptions,
  type ToolEndOptions,
  type Trace,
} from './types.js';

export type ReplayMode = 'deterministic' | 'hybrid';

export interface LiveModelRequest {
  model: string;
  provider?: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  agentId?: string;
}

export interface LiveModelResponse {
  output: string;
  finishReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export type LiveModel = (request: LiveModelRequest) => Promise<LiveModelResponse>;

export interface ReplayOptions {
  mode?: ReplayMode;
  /** Inclusive step index to start live or re-executed work. Earlier steps always use recorded stubs. */
  fromStep?: number;
  liveModel?: LiveModel;
  serviceName?: string;
}

export class ReplayDivergenceError extends Error {
  readonly expected: string;
  readonly actual: string;
  readonly stepIndex?: number;

  constructor(message: string, expected: string, actual: string, stepIndex?: number) {
    super(message);
    this.name = 'ReplayDivergenceError';
    this.expected = expected;
    this.actual = actual;
    if (stepIndex !== undefined) {
      this.stepIndex = stepIndex;
    }
  }
}

interface ToolStub {
  name: string;
  argumentHash?: string;
  result?: string;
  errorMessage?: string;
  status: string;
  stepIndex: number;
}

interface LlmStub {
  model: string;
  output?: string;
  finishReason?: string;
  inputTokens?: number;
  outputTokens?: number;
  stepIndex: number;
  agentId?: string;
}

export interface ReplayContext {
  mode: ReplayMode;
  fromStep: number;
  complete(request: LiveModelRequest): Promise<LiveModelResponse>;
  callTool(name: string, args?: unknown): Promise<unknown>;
}

export class ReplayHarness {
  readonly mode: ReplayMode;
  readonly fromStep: number;
  private readonly liveModel?: LiveModel;
  private readonly toolStubs: ToolStub[];
  private readonly llmStubs: LlmStub[];
  private toolCursor = 0;
  private llmCursor = 0;
  private readonly original: Trace;

  constructor(trace: Trace, options: ReplayOptions = {}) {
    this.original = trace;
    this.mode = options.mode ?? 'deterministic';
    this.fromStep = options.fromStep ?? 0;
    if (options.liveModel !== undefined) {
      this.liveModel = options.liveModel;
    }
    if (this.mode === 'hybrid' && !this.liveModel) {
      throw new Error("Replay mode 'hybrid' requires a liveModel function");
    }
    this.toolStubs = trace.spans
      .filter((span) => span.attributes[ATTR.spanType] === 'tool')
      .map((span) => toolStubFrom(span))
      .sort((a, b) => a.stepIndex - b.stepIndex);
    this.llmStubs = trace.spans
      .filter((span) => span.attributes[ATTR.spanType] === 'llm')
      .map((span) => llmStubFrom(span))
      .sort((a, b) => a.stepIndex - b.stepIndex);
  }

  context(): ReplayContext {
    return {
      mode: this.mode,
      fromStep: this.fromStep,
      complete: (request) => this.complete(request),
      callTool: (name, args) => this.callTool(name, args),
    };
  }

  async complete(request: LiveModelRequest): Promise<LiveModelResponse> {
    const stub = this.nextLlm(request.model);
    const useLive = this.mode === 'hybrid' && this.liveModel && stub.stepIndex >= this.fromStep;
    if (useLive && this.liveModel) {
      return this.liveModel(request);
    }
    if (stub.output === undefined) {
      throw new ReplayDivergenceError(
        `Recorded LLM call at step ${stub.stepIndex} has no output to replay`,
        request.model,
        'missing-output',
        stub.stepIndex,
      );
    }
    const response: LiveModelResponse = { output: stub.output };
    if (stub.finishReason !== undefined) {
      response.finishReason = stub.finishReason;
    }
    if (stub.inputTokens !== undefined || stub.outputTokens !== undefined) {
      response.usage = {};
      if (stub.inputTokens !== undefined) {
        response.usage.inputTokens = stub.inputTokens;
      }
      if (stub.outputTokens !== undefined) {
        response.usage.outputTokens = stub.outputTokens;
      }
    }
    return response;
  }

  callTool(name: string, args?: unknown): Promise<unknown> {
    try {
      const stub = this.nextTool(name, args);
      if (stub.errorMessage !== undefined && stub.status === 'ERROR') {
        return Promise.reject(new Error(stub.errorMessage));
      }
      if (stub.result === undefined) {
        return Promise.resolve(undefined);
      }
      try {
        return Promise.resolve(JSON.parse(stub.result) as unknown);
      } catch {
        return Promise.resolve(stub.result);
      }
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Re-emit the recorded run into a new trace (no application code).
   * Useful for export/round-trip tests. Hybrid mode with a live model will
   * replace LLM outputs from `fromStep` onward.
   */
  async resimulate(options: { serviceName?: string } = {}): Promise<Trace> {
    const recorder = new FlightRecorder({
      serviceName:
        options.serviceName ??
        String(this.original.resource.attributes['service.name'] ?? 'replay'),
      store: new MemoryTraceStore(),
      redaction: { enabled: false },
      redactOnFlush: false,
    });
    const run = recorder.startRun(`${this.original.run.name}:replay`);
    const agentsByOrigSpan = new Map<string, ReturnType<typeof run.startAgent>>();
    const lastAgentById = new Map<string, ReturnType<typeof run.startAgent>>();

    const sorted = [...this.original.spans].sort((a, b) => stepOf(a) - stepOf(b));
    for (const span of sorted) {
      const type = span.attributes[ATTR.spanType];
      if (type === 'run') {
        continue;
      }
      const agentId = String(span.attributes[ATTR.agentId] ?? 'default');
      const agentRole = String(span.attributes[ATTR.agentRole] ?? agentId);

      const resolveAgent = (forSpan: typeof span) => {
        if (forSpan.parentSpanId) {
          const parent = agentsByOrigSpan.get(forSpan.parentSpanId);
          if (parent) {
            return parent;
          }
        }
        const existing = lastAgentById.get(agentId);
        if (existing) {
          return existing;
        }
        const created = run.startAgent({ id: agentId, role: agentRole });
        lastAgentById.set(agentId, created);
        return created;
      };

      if (type === 'agent') {
        const options: StartAgentOptions = { id: agentId, role: agentRole };
        if (span.name !== `agent:${agentId}`) {
          options.name = span.name;
        }
        const extra: AttributeMap = {};
        const attempt = span.attributes[ATTR.agentAttempt];
        if (attempt !== undefined) {
          extra[ATTR.agentAttempt] = attempt;
        }
        if (Object.keys(extra).length > 0) {
          options.attributes = extra;
        }
        const parent = span.parentSpanId ? agentsByOrigSpan.get(span.parentSpanId) : undefined;
        if (parent) {
          options.parentSpanId = parent.spanId;
        }
        const agent = run.startAgent(options);
        agentsByOrigSpan.set(span.spanId, agent);
        lastAgentById.set(agentId, agent);
        for (const event of span.events) {
          if (event.name === 'afr.message' && event.attributes) {
            const role = String(event.attributes[ATTR.messageRole] ?? 'user');
            const content = String(event.attributes[ATTR.messageContent] ?? '');
            agent.addMessage({
              role: role as 'system' | 'user' | 'assistant' | 'tool' | 'developer',
              content,
            });
          }
        }
        continue;
      }

      const agent = resolveAgent(span);

      if (type === 'llm') {
        const model = String(span.attributes[ATTR.genAiModel] ?? 'unknown');
        const llmOptions: StartLlmOptions = { model };
        const provider = optionalString(span.attributes[ATTR.genAiSystem]);
        const temperature = optionalNumber(span.attributes[ATTR.genAiTemperature]);
        const maxTokens = optionalNumber(span.attributes[ATTR.genAiMaxTokens]);
        if (provider !== undefined) llmOptions.provider = provider;
        if (temperature !== undefined) llmOptions.temperature = temperature;
        if (maxTokens !== undefined) llmOptions.maxTokens = maxTokens;
        const llm = agent.startLlmCall(llmOptions);
        for (const event of span.events) {
          if (event.name === 'afr.message' && event.attributes) {
            const role = String(event.attributes[ATTR.messageRole] ?? 'user');
            const content = String(event.attributes[ATTR.messageContent] ?? '');
            llm.addMessage({
              role: role as 'system' | 'user' | 'assistant' | 'tool' | 'developer',
              content,
            });
          }
        }
        const step = stepOf(span);
        const useLive = this.mode === 'hybrid' && this.liveModel && step >= this.fromStep;
        if (useLive && this.liveModel) {
          const liveReq: LiveModelRequest = { model, messages: [], agentId };
          if (provider !== undefined) liveReq.provider = provider;
          const live = await this.liveModel(liveReq);
          const endOpts: LlmEndOptions = { output: live.output };
          if (live.finishReason !== undefined) endOpts.finishReason = live.finishReason;
          if (live.usage !== undefined) endOpts.usage = live.usage;
          llm.end(endOpts);
        } else {
          const endOpts: LlmEndOptions = {};
          const output = optionalString(span.attributes[ATTR.genAiOutput]);
          const finishReason = optionalString(span.attributes[ATTR.genAiFinishReason]);
          if (output !== undefined) endOpts.output = output;
          if (finishReason !== undefined) endOpts.finishReason = finishReason;
          const inputTokens = optionalNumber(span.attributes[ATTR.genAiInputTokens]);
          const outputTokens = optionalNumber(span.attributes[ATTR.genAiOutputTokens]);
          if (inputTokens !== undefined || outputTokens !== undefined) {
            endOpts.usage = {};
            if (inputTokens !== undefined) endOpts.usage.inputTokens = inputTokens;
            if (outputTokens !== undefined) endOpts.usage.outputTokens = outputTokens;
          }
          llm.end(endOpts);
        }
        continue;
      }
      if (type === 'tool') {
        const toolOptions: StartToolOptions = {
          name: String(span.attributes[ATTR.toolName] ?? span.name),
        };
        const callId = optionalString(span.attributes[ATTR.toolCallId]);
        if (callId !== undefined) toolOptions.callId = callId;
        const toolArgs = parseMaybeJson(optionalString(span.attributes[ATTR.toolArguments]));
        if (toolArgs !== undefined) toolOptions.arguments = toolArgs;
        const tool = agent.startToolCall(toolOptions);
        const toolEnd: ToolEndOptions = {};
        const toolResult = parseMaybeJson(optionalString(span.attributes[ATTR.toolResult]));
        if (toolResult !== undefined) toolEnd.result = toolResult;
        if (span.status.code === 'ERROR') {
          toolEnd.status = 'ERROR';
          if (span.status.message !== undefined) toolEnd.errorMessage = span.status.message;
        }
        tool.end(toolEnd);
        continue;
      }
      if (type === 'decision') {
        const decision: DecisionInput = {
          type: String(span.attributes[ATTR.decisionType] ?? 'unknown'),
          summary: String(span.attributes[ATTR.decisionSummary] ?? ''),
        };
        const decisionData = parseMaybeJson(optionalString(span.attributes[ATTR.decisionData]));
        if (decisionData !== undefined) decision.data = decisionData;
        agent.recordDecision(decision);
      }
    }

    for (const agent of agentsByOrigSpan.values()) {
      agent.end();
    }
    run.end();
    return recorder.flush(run);
  }

  private nextLlm(model: string): LlmStub {
    const stub = this.llmStubs[this.llmCursor];
    if (!stub) {
      throw new ReplayDivergenceError(
        `Replay issued an unexpected LLM call for model '${model}'`,
        'no further LLM calls',
        model,
      );
    }
    if (stub.model !== model) {
      throw new ReplayDivergenceError(
        `LLM model diverged at step ${stub.stepIndex}`,
        stub.model,
        model,
        stub.stepIndex,
      );
    }
    this.llmCursor += 1;
    return stub;
  }

  private nextTool(name: string, args?: unknown): ToolStub {
    const stub = this.toolStubs[this.toolCursor];
    if (!stub) {
      throw new ReplayDivergenceError(
        `Replay issued an unexpected tool call '${name}'`,
        'no further tool calls',
        name,
      );
    }
    if (stub.name !== name) {
      throw new ReplayDivergenceError(
        `Tool name diverged at step ${stub.stepIndex}`,
        stub.name,
        name,
        stub.stepIndex,
      );
    }
    if (args !== undefined && stub.argumentHash !== undefined) {
      const actual = fnv1aHex(stableStringify(args));
      if (actual !== stub.argumentHash) {
        throw new ReplayDivergenceError(
          `Tool arguments diverged at step ${stub.stepIndex}`,
          stub.argumentHash,
          actual,
          stub.stepIndex,
        );
      }
    }
    this.toolCursor += 1;
    return stub;
  }
}

export function replayFrom(trace: Trace, options?: ReplayOptions): ReplayHarness {
  return new ReplayHarness(trace, options);
}

function stepOf(span: Span): number {
  const value = span.attributes[ATTR.stepIndex];
  return typeof value === 'number' ? value : Number.MAX_SAFE_INTEGER;
}

function toolStubFrom(span: Span): ToolStub {
  const stub: ToolStub = {
    name: String(span.attributes[ATTR.toolName] ?? span.name),
    status: span.status.code,
    stepIndex: stepOf(span),
  };
  const argumentHash = optionalString(span.attributes[ATTR.argumentHash]);
  if (argumentHash !== undefined) {
    stub.argumentHash = argumentHash;
  }
  const result = optionalString(span.attributes[ATTR.toolResult]);
  if (result !== undefined) {
    stub.result = result;
  }
  if (span.status.message !== undefined) {
    stub.errorMessage = span.status.message;
  }
  return stub;
}

function llmStubFrom(span: Span): LlmStub {
  const stub: LlmStub = {
    model: String(span.attributes[ATTR.genAiModel] ?? 'unknown'),
    stepIndex: stepOf(span),
  };
  const output = optionalString(span.attributes[ATTR.genAiOutput]);
  if (output !== undefined) {
    stub.output = output;
  }
  const finishReason = optionalString(span.attributes[ATTR.genAiFinishReason]);
  if (finishReason !== undefined) {
    stub.finishReason = finishReason;
  }
  const inputTokens = optionalNumber(span.attributes[ATTR.genAiInputTokens]);
  if (inputTokens !== undefined) {
    stub.inputTokens = inputTokens;
  }
  const outputTokens = optionalNumber(span.attributes[ATTR.genAiOutputTokens]);
  if (outputTokens !== undefined) {
    stub.outputTokens = outputTokens;
  }
  const agentId = optionalString(span.attributes[ATTR.agentId]);
  if (agentId !== undefined) {
    stub.agentId = agentId;
  }
  return stub;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function parseMaybeJson(value: string | undefined): unknown {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}
