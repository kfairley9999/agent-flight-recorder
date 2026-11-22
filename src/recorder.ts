import { newTraceId } from './ids.js';
import { Redactor, type RedactionOptions } from './redaction.js';
import { RunSession, type RunHooks } from './run.js';
import { type MutableSpan } from './span.js';
import { MemoryTraceStore, type TraceStore } from './store.js';
import { createClock } from './time.js';
import type { AttributeMap, Trace, TraceResource } from './types.js';

export interface FlightRecorderOptions {
  serviceName: string;
  serviceVersion?: string;
  store?: TraceStore;
  redaction?: RedactionOptions;
  resourceAttributes?: AttributeMap;
  clock?: () => bigint;
  /** When true (default), flush() persists a redacted copy and keeps no raw buffers. */
  redactOnFlush?: boolean;
}

export class FlightRecorder {
  readonly serviceName: string;
  readonly store: TraceStore;
  private readonly redactor: Redactor;
  private readonly redactOnFlush: boolean;
  private readonly resource: TraceResource;
  private readonly clock: () => bigint;
  private readonly spans = new Map<string, MutableSpan[]>();
  private readonly runs = new Map<string, RunSession>();
  private step = 0;

  constructor(options: FlightRecorderOptions) {
    this.serviceName = options.serviceName;
    this.store = options.store ?? new MemoryTraceStore();
    this.redactor = new Redactor(options.redaction);
    this.redactOnFlush = options.redactOnFlush ?? true;
    this.clock = options.clock ?? createClock();
    const attributes: AttributeMap = {
      'service.name': options.serviceName,
      ...(options.resourceAttributes ?? {}),
    };
    if (options.serviceVersion !== undefined) {
      attributes['service.version'] = options.serviceVersion;
    }
    this.resource = { attributes };
  }

  startRun(name: string, traceId: string = newTraceId()): RunSession {
    if (this.runs.has(traceId)) {
      throw new Error(`A run with trace id ${traceId} is already active`);
    }
    const hooks: RunHooks = {
      clock: this.clock,
      nextStep: () => {
        const current = this.step;
        this.step += 1;
        return current;
      },
      register: (span) => {
        const list = this.spans.get(span.traceId) ?? [];
        list.push(span);
        this.spans.set(span.traceId, list);
      },
      resource: this.resource,
    };
    const run = new RunSession(traceId, name, hooks);
    this.runs.set(traceId, run);
    return run;
  }

  /**
   * End the run if needed, redact (by default), persist, and drop in-memory spans.
   * The returned trace is the persisted (redacted) document.
   */
  async flush(run: RunSession): Promise<Trace> {
    if (!run.isClosed()) {
      run.end();
    }
    const spans = this.spans.get(run.traceId) ?? [run.root];
    // Auto-end still-open child spans so the trace is well-formed.
    for (const span of spans) {
      if (!span.isEnded()) {
        span.end(this.clock(), 'UNSET');
      }
    }
    const raw = run.snapshot(spans);
    const stored = this.redactOnFlush ? this.redactor.redactTrace(raw) : raw;
    await this.store.save(stored);
    this.spans.delete(run.traceId);
    this.runs.delete(run.traceId);
    return stored;
  }

  async flushAll(): Promise<Trace[]> {
    const traces: Trace[] = [];
    for (const run of [...this.runs.values()]) {
      traces.push(await this.flush(run));
    }
    return traces;
  }
}
