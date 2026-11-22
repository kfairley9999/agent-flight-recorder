import { describe, expect, it } from 'vitest';
import { FlightRecorder } from '../src/recorder.js';
import { MemoryTraceStore } from '../src/store.js';
import { ATTR, EVENT, isTraceId } from '../src/index.js';

async function recordSimple() {
  const store = new MemoryTraceStore();
  const recorder = new FlightRecorder({
    serviceName: 'unit',
    serviceVersion: '0.1.0',
    store,
    redaction: { enabled: true },
  });
  const run = recorder.startRun('demo-run');
  const agent = run.startAgent({ id: 'researcher', role: 'researcher' });
  agent.addMessage({ role: 'user', content: 'hello jane.doe@example.com' });
  const llm = agent.startLlmCall({
    model: 'demo-model',
    provider: 'demo',
    temperature: 0,
    maxTokens: 64,
  });
  llm.addMessage({ role: 'user', content: 'hello' });
  llm.end({ output: 'hi', finishReason: 'stop', usage: { inputTokens: 4, outputTokens: 2 } });
  const tool = agent.startToolCall({ name: 'search', callId: 't1', arguments: { q: 'evals' } });
  tool.end({ result: { hits: 2 } });
  agent.recordDecision({ type: 'finish', summary: 'done', data: { ok: true } });
  const writer = run.startAgent({ id: 'writer', role: 'writer' });
  run.linkTo(writer, agent, 'handoff');
  writer.end();
  agent.end();
  run.end();
  const trace = await recorder.flush(run);
  return { trace, store };
}

describe('FlightRecorder', () => {
  it('records parent/child spans, messages, tools, decisions, and links', async () => {
    const { trace } = await recordSimple();
    expect(isTraceId(trace.run.id)).toBe(true);
    expect(trace.run.status).toBe('OK');
    expect(trace.resource.attributes['service.name']).toBe('unit');
    expect(trace.resource.attributes['service.version']).toBe('0.1.0');

    const types = trace.spans.map((s) => s.attributes[ATTR.spanType]);
    expect(types).toContain('run');
    expect(types).toContain('agent');
    expect(types).toContain('llm');
    expect(types).toContain('tool');
    expect(types).toContain('decision');

    const researcher = trace.spans.find(
      (s) => s.attributes[ATTR.agentId] === 'researcher' && s.attributes[ATTR.spanType] === 'agent',
    );
    const llm = trace.spans.find((s) => s.attributes[ATTR.spanType] === 'llm');
    const tool = trace.spans.find((s) => s.attributes[ATTR.spanType] === 'tool');
    const writer = trace.spans.find(
      (s) => s.attributes[ATTR.agentId] === 'writer' && s.attributes[ATTR.spanType] === 'agent',
    );
    expect(researcher).toBeTruthy();
    expect(llm?.parentSpanId).toBe(researcher?.spanId);
    expect(tool?.parentSpanId).toBe(researcher?.spanId);
    expect(tool?.attributes[ATTR.toolName]).toBe('search');
    expect(tool?.events.some((e) => e.name === EVENT.toolResult)).toBe(true);
    expect(writer?.links.some((l) => l.spanId === researcher?.spanId)).toBe(true);
    expect(llm?.attributes[ATTR.genAiModel]).toBe('demo-model');
    expect(llm?.attributes[ATTR.genAiTemperature]).toBe(0);
  });

  it('redacts secrets and PII before the store sees them', async () => {
    const { trace, store } = await recordSimple();
    const stored = await store.load(trace.run.id);
    expect(stored).toBeTruthy();
    const blob = JSON.stringify(stored);
    expect(blob).not.toContain('jane.doe@example.com');
    expect(blob).toContain('[REDACTED:email]');
    expect(trace.redaction.applied).toBe(true);
    expect(trace.redaction.rulesTriggered).toContain('email');
  });

  it('assigns monotonic step indices and auto-ends open children on flush', async () => {
    const recorder = new FlightRecorder({ serviceName: 'unit', store: new MemoryTraceStore() });
    const run = recorder.startRun('open');
    run.startAgent({ id: 'a', role: 'a' });
    const trace = await recorder.flush(run);
    const steps = trace.spans.map((s) => s.attributes[ATTR.stepIndex] as number);
    expect(new Set(steps).size).toBe(steps.length);
    expect(trace.spans.every((s) => s.endTimeUnixNano !== undefined)).toBe(true);
  });

  it('rejects work on an ended run and a second run with the same id', async () => {
    const recorder = new FlightRecorder({ serviceName: 'unit', store: new MemoryTraceStore() });
    const run = recorder.startRun('once', 'c'.repeat(32));
    run.end();
    expect(() => run.startAgent({ id: 'x', role: 'x' })).toThrow(/already ended/);
    expect(() => recorder.startRun('twice', 'c'.repeat(32))).toThrow(/already active/);
    await recorder.flush(run);
  });

  it('records tool and llm errors', async () => {
    const recorder = new FlightRecorder({
      serviceName: 'unit',
      store: new MemoryTraceStore(),
      redactOnFlush: false,
    });
    const run = recorder.startRun('errors');
    const agent = run.startAgent({ id: 'a', role: 'a' });
    agent.startToolCall({ name: 'boom' }).end({ status: 'ERROR', errorMessage: 'timeout' });
    agent.startLlmCall({ model: 'm' }).end({ status: 'ERROR', errorMessage: 'rate limited' });
    const trace = await recorder.flush(run);
    const tool = trace.spans.find((s) => s.attributes[ATTR.spanType] === 'tool');
    const llm = trace.spans.find((s) => s.attributes[ATTR.spanType] === 'llm');
    expect(tool?.status.code).toBe('ERROR');
    expect(llm?.status.code).toBe('ERROR');
    expect(tool?.events.some((e) => e.name === EVENT.exception)).toBe(true);
  });

  it('flushAll persists every open run', async () => {
    const store = new MemoryTraceStore();
    const recorder = new FlightRecorder({ serviceName: 'unit', store });
    recorder.startRun('one');
    recorder.startRun('two');
    const traces = await recorder.flushAll();
    expect(traces).toHaveLength(2);
    expect((await store.list()).length).toBe(2);
  });

  it('does not allow mutating an ended span', async () => {
    const recorder = new FlightRecorder({ serviceName: 'unit', store: new MemoryTraceStore() });
    const run = recorder.startRun('ended-span');
    const agent = run.startAgent({ id: 'a', role: 'a' });
    agent.end();
    expect(() => agent.addMessage({ role: 'user', content: 'nope' })).toThrow(/already ended/);
    await recorder.flush(run);
  });
});
