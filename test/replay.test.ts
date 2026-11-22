import { describe, expect, it } from 'vitest';
import { FlightRecorder } from '../src/recorder.js';
import { MemoryTraceStore } from '../src/store.js';
import { ReplayDivergenceError, replayFrom } from '../src/replay.js';
import { diffRuns } from '../src/diff.js';
import { ATTR } from '../src/types.js';

async function recordedRun() {
  const recorder = new FlightRecorder({
    serviceName: 'unit',
    store: new MemoryTraceStore(),
    redactOnFlush: false,
  });
  const run = recorder.startRun('path');
  const agent = run.startAgent({ id: 'worker', role: 'worker' });
  agent.addMessage({ role: 'user', content: 'go' });
  const llm = agent.startLlmCall({ model: 'demo', provider: 'demo' });
  llm.end({ output: 'call search', finishReason: 'tool_calls' });
  agent
    .startToolCall({ name: 'search', arguments: { q: 'x' } })
    .end({ result: { hits: ['alpha'] } });
  const llm2 = agent.startLlmCall({ model: 'demo', provider: 'demo' });
  llm2.end({
    output: 'done: alpha',
    finishReason: 'stop',
    usage: { inputTokens: 8, outputTokens: 4 },
  });
  agent.end();
  return recorder.flush(run);
}

describe('ReplayHarness', () => {
  it('replays recorded tool and model outputs deterministically', async () => {
    const trace = await recordedRun();
    const harness = replayFrom(trace);
    const ctx = harness.context();
    const first = await ctx.complete({ model: 'demo', messages: [] });
    expect(first.output).toBe('call search');
    const tool = await ctx.callTool('search', { q: 'x' });
    expect(tool).toEqual({ hits: ['alpha'] });
    const second = await ctx.complete({ model: 'demo', messages: [] });
    expect(second.output).toBe('done: alpha');
    expect(second.usage?.outputTokens).toBe(4);
  });

  it('throws when the application issues a different tool or model', async () => {
    const trace = await recordedRun();
    const ctx = replayFrom(trace).context();
    await ctx.complete({ model: 'demo', messages: [] });
    await expect(ctx.callTool('browse')).rejects.toBeInstanceOf(ReplayDivergenceError);
  });

  it('throws when extra calls are issued past the recording', async () => {
    const trace = await recordedRun();
    const ctx = replayFrom(trace).context();
    await ctx.complete({ model: 'demo', messages: [] });
    await ctx.callTool('search');
    await ctx.complete({ model: 'demo', messages: [] });
    await expect(ctx.complete({ model: 'demo', messages: [] })).rejects.toThrow(
      /unexpected LLM call/,
    );
  });

  it('uses a live model from fromStep in hybrid mode', async () => {
    const trace = await recordedRun();
    const llmSteps = trace.spans
      .filter((s) => s.attributes[ATTR.spanType] === 'llm')
      .map((s) => s.attributes[ATTR.stepIndex] as number)
      .sort((a, b) => a - b);
    const secondLlm = llmSteps[1];
    if (secondLlm === undefined) {
      throw new Error('expected two LLM steps');
    }
    const harness = replayFrom(trace, {
      mode: 'hybrid',
      fromStep: secondLlm,
      liveModel: () => Promise.resolve({ output: 'live alternative', finishReason: 'stop' }),
    });
    const ctx = harness.context();
    expect((await ctx.complete({ model: 'demo', messages: [] })).output).toBe('call search');
    await ctx.callTool('search');
    expect((await ctx.complete({ model: 'demo', messages: [] })).output).toBe('live alternative');
  });

  it('resimulate copies a deterministic run with equivalent payloads', async () => {
    const trace = await recordedRun();
    const copy = await replayFrom(trace).resimulate({ serviceName: 'unit' });
    const diff = diffRuns(trace, copy);
    expect(diff.equal).toBe(true);
  });

  it('resimulate in hybrid mode diverges when the live model changes the output', async () => {
    const trace = await recordedRun();
    const copy = await replayFrom(trace, {
      mode: 'hybrid',
      fromStep: 0,
      liveModel: () => Promise.resolve({ output: 'brand new wording' }),
    }).resimulate();
    const diff = diffRuns(trace, copy);
    expect(diff.equal).toBe(false);
    expect(diff.firstDivergence?.kind).toBe('llm_output');
  });

  it('requires a live model for hybrid mode', () => {
    expect(() => replayFrom({} as never, { mode: 'hybrid' })).toThrow(/liveModel/);
  });
});
