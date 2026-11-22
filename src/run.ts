import { currentScope, runWithScope } from './context.js';
import { fnv1aHex, stableStringify, toAttributeValue } from './serialize.js';
import { LlmSpanHandle, MutableSpan, ToolSpanHandle } from './span.js';
import { nanosToIso } from './time.js';
import {
  ATTR,
  EVENT,
  SDK_NAME,
  SDK_VERSION,
  SCHEMA_VERSION,
  type AfrSpanType,
  type AttributeMap,
  type DecisionInput,
  type LinkType,
  type MessageInput,
  type SpanKind,
  type SpanStatusCode,
  type StartAgentOptions,
  type StartLlmOptions,
  type StartToolOptions,
  type Trace,
  type TraceResource,
} from './types.js';

export interface RunHooks {
  clock: () => bigint;
  nextStep: () => number;
  register: (span: MutableSpan) => void;
  resource: TraceResource;
}

export class AgentHandle {
  constructor(
    readonly span: MutableSpan,
    private readonly run: RunSession,
  ) {}

  get spanId(): string {
    return this.span.spanId;
  }

  get agentId(): string {
    const value = this.span.attributes[ATTR.agentId];
    return typeof value === 'string' ? value : 'unknown';
  }

  addMessage(message: MessageInput): this {
    this.span.addMessage(message, this.run.now());
    return this;
  }

  startLlmCall(options: StartLlmOptions): LlmSpanHandle {
    return this.run.startLlmCall(options, this.span);
  }

  startToolCall(options: StartToolOptions): ToolSpanHandle {
    return this.run.startToolCall(options, this.span);
  }

  recordDecision(input: DecisionInput): MutableSpan {
    return this.run.recordDecision(input, this.span);
  }

  startAgent(options: StartAgentOptions): AgentHandle {
    return this.run.startAgent({
      ...options,
      parentSpanId: options.parentSpanId ?? this.span.spanId,
    });
  }

  end(status?: SpanStatusCode): this {
    this.span.end(this.run.now(), status);
    return this;
  }
}

export class RunSession {
  readonly startedAt: string;
  private status: SpanStatusCode = 'UNSET';
  endedAt: string | undefined;
  private closed = false;
  readonly root: MutableSpan;

  constructor(
    readonly traceId: string,
    readonly name: string,
    private readonly hooks: RunHooks,
  ) {
    this.startedAt = nanosToIso(hooks.clock());
    this.root = this.createSpan({
      name: `run:${name}`,
      type: 'run',
      kind: 'internal',
      attributes: { [ATTR.spanType]: 'run' },
    });
  }

  now(): bigint {
    return this.hooks.clock();
  }

  startAgent(options: StartAgentOptions): AgentHandle {
    this.assertOpen();
    const parentSpanId = options.parentSpanId ?? currentScope()?.span.spanId ?? this.root.spanId;
    const span = this.createSpan({
      name: options.name ?? `agent:${options.id}`,
      type: 'agent',
      kind: 'internal',
      parentSpanId,
      attributes: {
        [ATTR.spanType]: 'agent',
        [ATTR.agentId]: options.id,
        [ATTR.agentRole]: options.role,
        ...(options.attributes ?? {}),
      },
    });
    return new AgentHandle(span, this);
  }

  startLlmCall(options: StartLlmOptions, parent?: MutableSpan): LlmSpanHandle {
    this.assertOpen();
    const parentSpan = parent ?? currentScope()?.span ?? this.root;
    const attributes: AttributeMap = {
      [ATTR.spanType]: 'llm',
      [ATTR.genAiModel]: options.model,
      ...(options.attributes ?? {}),
    };
    if (options.provider !== undefined) {
      attributes[ATTR.genAiSystem] = options.provider;
    }
    if (options.temperature !== undefined) {
      attributes[ATTR.genAiTemperature] = options.temperature;
    }
    if (options.maxTokens !== undefined) {
      attributes[ATTR.genAiMaxTokens] = options.maxTokens;
    }
    if (options.topP !== undefined) {
      attributes[ATTR.genAiTopP] = options.topP;
    }
    const agentId = parentSpan.attributes[ATTR.agentId];
    const agentRole = parentSpan.attributes[ATTR.agentRole];
    if (typeof agentId === 'string') {
      attributes[ATTR.agentId] = agentId;
    }
    if (typeof agentRole === 'string') {
      attributes[ATTR.agentRole] = agentRole;
    }
    const span = this.createSpan({
      name: options.name ?? `llm:${options.model}`,
      type: 'llm',
      kind: 'client',
      parentSpanId: parentSpan.spanId,
      attributes,
    });
    return new LlmSpanHandle(span, this.hooks.clock);
  }

  startToolCall(options: StartToolOptions, parent?: MutableSpan): ToolSpanHandle {
    this.assertOpen();
    const parentSpan = parent ?? currentScope()?.span ?? this.root;
    const encodedArgs =
      options.arguments === undefined ? undefined : stableStringify(options.arguments);
    const attributes: AttributeMap = {
      [ATTR.spanType]: 'tool',
      [ATTR.toolName]: options.name,
      ...(options.attributes ?? {}),
    };
    if (options.callId !== undefined) {
      attributes[ATTR.toolCallId] = options.callId;
    }
    if (encodedArgs !== undefined) {
      attributes[ATTR.toolArguments] = encodedArgs;
      attributes[ATTR.argumentHash] = fnv1aHex(encodedArgs);
    }
    const agentId = parentSpan.attributes[ATTR.agentId];
    const agentRole = parentSpan.attributes[ATTR.agentRole];
    if (typeof agentId === 'string') {
      attributes[ATTR.agentId] = agentId;
    }
    if (typeof agentRole === 'string') {
      attributes[ATTR.agentRole] = agentRole;
    }
    const span = this.createSpan({
      name: options.name,
      type: 'tool',
      kind: 'client',
      parentSpanId: parentSpan.spanId,
      attributes,
    });
    return new ToolSpanHandle(span, this.hooks.clock);
  }

  recordDecision(input: DecisionInput, parent?: MutableSpan): MutableSpan {
    this.assertOpen();
    const parentSpan = parent ?? currentScope()?.span ?? this.root;
    const attributes: AttributeMap = {
      [ATTR.spanType]: 'decision',
      [ATTR.decisionType]: input.type,
      [ATTR.decisionSummary]: input.summary,
      ...(input.attributes ?? {}),
    };
    if (input.data !== undefined) {
      attributes[ATTR.decisionData] = toAttributeValue(input.data);
    }
    const agentId = parentSpan.attributes[ATTR.agentId];
    if (typeof agentId === 'string') {
      attributes[ATTR.agentId] = agentId;
    }
    const span = this.createSpan({
      name: `decision:${input.type}`,
      type: 'decision',
      kind: 'internal',
      parentSpanId: parentSpan.spanId,
      attributes,
    });
    span.addEvent(
      EVENT.decision,
      {
        [ATTR.decisionType]: input.type,
        [ATTR.decisionSummary]: input.summary,
      },
      this.now(),
    );
    span.end(this.now(), 'OK');
    return span;
  }

  link(
    from: AgentHandle | MutableSpan,
    to: AgentHandle | MutableSpan | { spanId: string },
    type: LinkType = 'handoff',
  ): void {
    this.linkTo(from, to, type);
  }

  /**
   * Record a causal link on `source` pointing at `target`.
   * Typical use: writer.linkTo(researcher, 'uses_result').
   */
  linkTo(
    source: AgentHandle | MutableSpan | { spanId: string },
    target: AgentHandle | MutableSpan | { spanId: string },
    type: LinkType = 'handoff',
  ): void {
    const sourceSpan = this.lookupMutable(source);
    sourceSpan.addLink({
      traceId: this.traceId,
      spanId: spanIdOf(target),
      attributes: { [ATTR.linkType]: type },
    });
  }

  end(status: SpanStatusCode = 'OK'): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.status = status;
    this.endedAt = nanosToIso(this.now());
    if (!this.root.isEnded()) {
      this.root.end(this.now(), status);
    }
  }

  isClosed(): boolean {
    return this.closed;
  }

  getStatus(): SpanStatusCode {
    return this.status;
  }

  withAgent<T>(agent: AgentHandle, fn: () => T): T {
    return runWithScope({ run: this, span: agent.span }, fn);
  }

  snapshot(spans: MutableSpan[]): Trace {
    const endedAt = this.endedAt;
    const runDoc: Trace['run'] = {
      id: this.traceId,
      name: this.name,
      startedAt: this.startedAt,
      status: this.status,
    };
    if (endedAt !== undefined) {
      runDoc.endedAt = endedAt;
    }
    const trace: Trace = {
      schemaVersion: SCHEMA_VERSION,
      resource: {
        attributes: {
          'service.name': String(this.hooks.resource.attributes['service.name'] ?? 'agent-system'),
          'telemetry.sdk.name': SDK_NAME,
          'telemetry.sdk.language': 'typescript',
          'telemetry.sdk.version': SDK_VERSION,
          ...this.hooks.resource.attributes,
        },
      },
      run: runDoc,
      spans: spans.map((span) => span.snapshot()),
      redaction: { applied: false, rulesTriggered: [], redactedCount: 0 },
    };
    return trace;
  }

  private createSpan(options: {
    name: string;
    type: AfrSpanType;
    kind: SpanKind;
    parentSpanId?: string;
    attributes: AttributeMap;
  }): MutableSpan {
    const spanOptions: ConstructorParameters<typeof MutableSpan>[0] = {
      traceId: this.traceId,
      name: options.name,
      kind: options.kind,
      startTimeUnixNano: this.now(),
      attributes: options.attributes,
      stepIndex: this.hooks.nextStep(),
    };
    if (options.parentSpanId !== undefined) {
      spanOptions.parentSpanId = options.parentSpanId;
    }
    const span = new MutableSpan(spanOptions);
    this.hooks.register(span);
    return span;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`Run ${this.traceId} is already ended`);
    }
  }

  private lookupMutable(ref: AgentHandle | MutableSpan | { spanId: string }): MutableSpan {
    if (ref instanceof AgentHandle) {
      return ref.span;
    }
    if (ref instanceof MutableSpan) {
      return ref;
    }
    if (ref.spanId === this.root.spanId) {
      return this.root;
    }
    throw new Error(
      `Cannot add a link from unknown span ${ref.spanId}; pass an AgentHandle or MutableSpan`,
    );
  }
}

function spanIdOf(ref: AgentHandle | MutableSpan | { spanId: string }): string {
  if (ref instanceof AgentHandle) {
    return ref.span.spanId;
  }
  return ref.spanId;
}
