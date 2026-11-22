import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileTraceStore, MemoryTraceStore, loadTraceFile, saveTraceFile } from '../src/store.js';
import { parseTrace, safeParseTrace } from '../src/schema.js';
import { otlpSpanCount, toOtlpJson } from '../src/otel.js';
import { FlightRecorder } from '../src/recorder.js';
import { SCHEMA_VERSION } from '../src/types.js';

async function sampleTrace() {
  const store = new MemoryTraceStore();
  const recorder = new FlightRecorder({ serviceName: 'unit', store, redactOnFlush: false });
  const run = recorder.startRun('persist');
  const agent = run.startAgent({ id: 'a', role: 'a' });
  agent.startLlmCall({ model: 'm', temperature: 0.2 }).end({ output: 'ok' });
  agent.end();
  return recorder.flush(run);
}

describe('stores', () => {
  it('memory store clones on save and load', async () => {
    const store = new MemoryTraceStore();
    const trace = await sampleTrace();
    await store.save(trace);
    const loaded = await store.load(trace.run.id);
    expect(loaded).toEqual(trace);
    if (loaded) {
      loaded.run.name = 'mutated';
    }
    expect((await store.load(trace.run.id))?.run.name).toBe('persist');
    expect(await store.list()).toEqual([trace.run.id]);
    store.clear();
    expect(await store.list()).toEqual([]);
    expect(await store.load('missing')).toBeUndefined();
  });

  it('file store writes .afr.json and sanitizes run ids', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'afr-'));
    try {
      const store = new FileTraceStore(dir);
      expect(await store.list()).toEqual([]);
      const trace = await sampleTrace();
      await store.save(trace);
      expect(await store.list()).toEqual([trace.run.id]);
      const loaded = await store.load(trace.run.id);
      expect(loaded?.run.name).toBe('persist');
      expect(store.pathFor('weird/id')).toContain('weird_id.afr.json');
      expect(await store.load('nope')).toBeUndefined();

      const custom = join(dir, 'custom.json');
      await saveTraceFile(custom, trace);
      const again = await loadTraceFile(custom);
      expect(again.run.id).toBe(trace.run.id);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('schema', () => {
  it('accepts a flushed trace and rejects a broken one', async () => {
    const trace = await sampleTrace();
    expect(parseTrace(trace).schemaVersion).toBe(SCHEMA_VERSION);
    const bad = safeParseTrace({ ...trace, schemaVersion: '9.9.9' });
    expect(bad.ok).toBe(false);
  });
});

describe('otlp export', () => {
  it('exports every span with ids, timestamps, and attributes', async () => {
    const trace = await sampleTrace();
    const doc = toOtlpJson(trace);
    expect(otlpSpanCount(doc)).toBe(trace.spans.length);
    const scope = doc.resourceSpans[0]?.scopeSpans[0];
    expect(scope?.scope.name).toBe('agent-flight-recorder');
    const llm = scope?.spans.find((s) => s.name.startsWith('llm:'));
    expect(llm?.traceId).toBe(trace.run.id);
    expect(llm?.kind).toBe(3);
    expect(llm?.attributes.some((a) => a.key === 'gen_ai.request.model')).toBe(true);
    expect(llm?.parentSpanId).toBeTruthy();
  });
});
