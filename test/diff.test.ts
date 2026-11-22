import { describe, expect, it } from 'vitest';
import { diffRuns } from '../src/diff.js';
import { FlightRecorder } from '../src/recorder.js';
import { MemoryTraceStore } from '../src/store.js';
import { ATTR, type Trace } from '../src/types.js';

async function makeRun(
  output: string,
  toolResult: unknown = { ok: true },
  extra = false,
): Promise<Trace> {
  const recorder = new FlightRecorder({
    serviceName: 'unit',
    store: new MemoryTraceStore(),
    redactOnFlush: false,
  });
  const run = recorder.startRun('cmp');
  const agent = run.startAgent({ id: 'a', role: 'a' });
  agent.addMessage({ role: 'user', content: 'task' });
  agent.startLlmCall({ model: 'm' }).end({ output });
  agent.startToolCall({ name: 't', arguments: { n: 1 } }).end({ result: toolResult });
  if (extra) {
    agent.recordDecision({ type: 'retry', summary: 'try again' });
  }
  agent.end();
  return recorder.flush(run);
}

describe('diffRuns', () => {
  it('reports equal traces as equal even when ids and timestamps differ', async () => {
    const a = await makeRun('hello');
    const b = await makeRun('hello');
    expect(a.run.id).not.toBe(b.run.id);
    const diff = diffRuns(a, b);
    expect(diff.equal).toBe(true);
    expect(diff.firstDivergence).toBeUndefined();
  });

  it('finds the first LLM output divergence', async () => {
    const a = await makeRun('hello');
    const b = await makeRun('goodbye');
    const diff = diffRuns(a, b);
    expect(diff.equal).toBe(false);
    expect(diff.firstDivergence?.kind).toBe('llm_output');
    expect(diff.firstDivergence?.left).toBe('hello');
    expect(diff.firstDivergence?.right).toBe('goodbye');
  });

  it('finds tool result and message changes', async () => {
    const a = await makeRun('hello', { ok: true });
    const b = await makeRun('hello', { ok: false });
    const diff = diffRuns(a, b);
    expect(diff.firstDivergence?.kind).toBe('tool_result');

    const c = await makeRun('hello');
    const user = c.spans.find((s) => s.attributes[ATTR.spanType] === 'agent');
    const event = user?.events.find((e) => e.name === 'afr.message');
    if (event?.attributes) {
      event.attributes['afr.message.content'] = 'other';
    }
    const changed = diffRuns(await makeRun('hello'), c);
    expect(changed.divergences.some((d) => d.kind === 'message')).toBe(true);
  });

  it('detects added and missing spans', async () => {
    const a = await makeRun('hello', { ok: true }, false);
    const b = await makeRun('hello', { ok: true }, true);
    const added = diffRuns(a, b);
    expect(added.divergences.some((d) => d.kind === 'span_added')).toBe(true);
    const missing = diffRuns(b, a);
    expect(missing.divergences.some((d) => d.kind === 'span_missing')).toBe(true);
  });
});
