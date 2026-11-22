import { newSpanId } from './ids.js';
import { fnv1aHex, stableStringify, toAttributeValue } from './serialize.js';
import { nanoString } from './time.js';
import {
  ATTR,
  EVENT,
  type AttributeMap,
  type LlmEndOptions,
  type MessageInput,
  type Span,
  type SpanEvent,
  type SpanKind,
  type SpanLink,
  type SpanStatus,
  type SpanStatusCode,
  type ToolEndOptions,
} from './types.js';

export interface MutableSpanOptions {
  traceId: string;
  parentSpanId?: string;
  name: string;
  kind?: SpanKind;
  startTimeUnixNano: bigint;
  attributes?: AttributeMap;
  links?: SpanLink[];
  stepIndex: number;
}

export class MutableSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: SpanKind;
  readonly startTimeUnixNano: bigint;
  endTimeUnixNano: bigint | undefined;
  status: SpanStatus;
  readonly attributes: AttributeMap;
  readonly events: SpanEvent[] = [];
  readonly links: SpanLink[];
  private ended = false;

  constructor(options: MutableSpanOptions) {
    this.traceId = options.traceId;
    this.spanId = newSpanId();
    if (options.parentSpanId !== undefined) {
      this.parentSpanId = options.parentSpanId;
    }
    this.name = options.name;
    this.kind = options.kind ?? 'internal';
    this.startTimeUnixNano = options.startTimeUnixNano;
    this.status = { code: 'UNSET' };
    this.attributes = { ...(options.attributes ?? {}) };
    this.attributes[ATTR.stepIndex] = options.stepIndex;
    this.links = options.links ? [...options.links] : [];
  }

  setAttribute(key: string, value: unknown): this {
    this.assertOpen();
    this.attributes[key] = toAttributeValue(value);
    return this;
  }

  setAttributes(attrs: Record<string, unknown>): this {
    for (const [key, value] of Object.entries(attrs)) {
      this.setAttribute(key, value);
    }
    return this;
  }

  addEvent(name: string, attributes?: Record<string, unknown>, timeUnixNano?: bigint): this {
    this.assertOpen();
    const event: SpanEvent = {
      name,
      timeUnixNano: nanoString(timeUnixNano ?? this.startTimeUnixNano),
    };
    if (attributes) {
      const mapped: AttributeMap = {};
      for (const [key, value] of Object.entries(attributes)) {
        mapped[key] = toAttributeValue(value);
      }
      event.attributes = mapped;
    }
    this.events.push(event);
    return this;
  }

  addMessage(message: MessageInput, timeUnixNano?: bigint): this {
    const attributes: Record<string, unknown> = {
      [ATTR.messageRole]: message.role,
      [ATTR.messageContent]: message.content,
    };
    if (message.id !== undefined) {
      attributes[ATTR.messageId] = message.id;
    }
    if (message.toolCallId !== undefined) {
      attributes[ATTR.messageToolCallId] = message.toolCallId;
    }
    if (message.name !== undefined) {
      attributes[ATTR.messageName] = message.name;
    }
    return this.addEvent(EVENT.message, attributes, timeUnixNano);
  }

  addLink(link: SpanLink): this {
    this.assertOpen();
    this.links.push(link);
    return this;
  }

  setStatus(code: SpanStatusCode, message?: string): this {
    this.assertOpen();
    const status: SpanStatus = { code };
    if (message !== undefined) {
      status.message = message;
    }
    this.status = status;
    return this;
  }

  recordException(error: unknown, timeUnixNano?: bigint): this {
    const message = error instanceof Error ? error.message : String(error);
    const type = error instanceof Error ? error.name : 'Error';
    this.addEvent(
      EVENT.exception,
      { 'exception.type': type, 'exception.message': message },
      timeUnixNano,
    );
    this.setStatus('ERROR', message);
    return this;
  }

  end(endTimeUnixNano: bigint, status?: SpanStatusCode): this {
    if (this.ended) {
      return this;
    }
    this.ended = true;
    this.endTimeUnixNano = endTimeUnixNano;
    if (status !== undefined && this.status.code === 'UNSET') {
      this.status = { code: status };
    } else if (this.status.code === 'UNSET') {
      this.status = { code: 'OK' };
    }
    return this;
  }

  isEnded(): boolean {
    return this.ended;
  }

  snapshot(): Span {
    const span: Span = {
      traceId: this.traceId,
      spanId: this.spanId,
      name: this.name,
      kind: this.kind,
      startTimeUnixNano: nanoString(this.startTimeUnixNano),
      status: { ...this.status },
      attributes: { ...this.attributes },
      events: this.events.map((event) => {
        const copy: SpanEvent = { name: event.name, timeUnixNano: event.timeUnixNano };
        if (event.attributes) {
          copy.attributes = { ...event.attributes };
        }
        return copy;
      }),
      links: this.links.map((link) => {
        const copy: SpanLink = { traceId: link.traceId, spanId: link.spanId };
        if (link.attributes) {
          copy.attributes = { ...link.attributes };
        }
        return copy;
      }),
    };
    if (this.parentSpanId !== undefined) {
      span.parentSpanId = this.parentSpanId;
    }
    if (this.endTimeUnixNano !== undefined) {
      span.endTimeUnixNano = nanoString(this.endTimeUnixNano);
    }
    return span;
  }

  private assertOpen(): void {
    if (this.ended) {
      throw new Error(`Span ${this.spanId} (${this.name}) is already ended`);
    }
  }
}

export class LlmSpanHandle {
  constructor(
    readonly span: MutableSpan,
    private readonly clock: () => bigint,
  ) {}

  addMessage(message: MessageInput): this {
    this.span.addMessage(message, this.clock());
    return this;
  }

  end(options: LlmEndOptions = {}): this {
    if (options.output !== undefined) {
      this.span.setAttribute(ATTR.genAiOutput, options.output);
      this.span.setAttribute(ATTR.outputHash, fnv1aHex(options.output));
    }
    if (options.finishReason !== undefined) {
      this.span.setAttribute(ATTR.genAiFinishReason, options.finishReason);
    }
    if (options.usage?.inputTokens !== undefined) {
      this.span.setAttribute(ATTR.genAiInputTokens, options.usage.inputTokens);
    }
    if (options.usage?.outputTokens !== undefined) {
      this.span.setAttribute(ATTR.genAiOutputTokens, options.usage.outputTokens);
    }
    if (options.errorMessage !== undefined) {
      this.span.recordException(new Error(options.errorMessage), this.clock());
    }
    this.span.end(this.clock(), options.status);
    return this;
  }
}

export class ToolSpanHandle {
  constructor(
    readonly span: MutableSpan,
    private readonly clock: () => bigint,
  ) {}

  end(options: ToolEndOptions = {}): this {
    if (options.result !== undefined) {
      const serialized =
        typeof options.result === 'string' ? options.result : stableStringify(options.result);
      this.span.setAttribute(ATTR.toolResult, serialized);
      this.span.setAttribute(ATTR.outputHash, fnv1aHex(serialized));
      this.span.addEvent(EVENT.toolResult, { [ATTR.toolResult]: serialized }, this.clock());
    }
    if (options.errorMessage !== undefined) {
      this.span.recordException(new Error(options.errorMessage), this.clock());
    }
    this.span.end(this.clock(), options.status);
    return this;
  }
}
