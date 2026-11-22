import { describe, expect, it } from 'vitest';
import { instrumentMcpTools } from '../src/adapters/mcp.js';
import { runToolLoop, textOnlyLoopModel } from '../src/adapters/tool-loop.js';
import { FlightRecorder } from '../src/recorder.js';
import { MemoryTraceStore } from '../src/store.js';
import { ATTR } from '../src/types.js';

describe('tool loop adapter', () => {
  it('records a multi-turn tool-calling loop including a failing tool', async () => {
    const recorder = new FlightRecorder({
      serviceName: 'unit',
      store: new MemoryTraceStore(),
      redactOnFlush: false,
    });
    const run = recorder.startRun('loop');
    const agent = run.startAgent({ id: 'bot', role: 'bot' });
    agent.addMessage({ role: 'user', content: 'look up 1 then 2' });

    let turn = 0;
    const result = await runToolLoop({
      run,
      agent,
      model: 'demo',
      provider: 'demo',
      tools: [
        {
          name: 'lookup',
          handler: (args) => {
            if (args['id'] === 2) {
              throw new Error('not found');
            }
            return { id: args['id'], value: 'ok' };
          },
        },
      ],
      complete: () => {
        turn += 1;
        if (turn === 1) {
          return {
            toolCalls: [{ name: 'lookup', arguments: { id: 1 }, callId: '1' }],
            finishReason: 'tool_calls',
          };
        }
        if (turn === 2) {
          return {
            toolCalls: [{ name: 'lookup', arguments: { id: 2 }, callId: '2' }],
            finishReason: 'tool_calls',
          };
        }
        if (turn === 3) {
          return {
            toolCalls: [{ name: 'missing', arguments: {}, callId: '3' }],
            finishReason: 'tool_calls',
          };
        }
        return { assistant: 'finished', finishReason: 'stop' };
      },
      maxTurns: 5,
    });

    expect(result.finalText).toBe('finished');
    agent.end();
    const trace = await recorder.flush(run);
    const tools = trace.spans.filter((s) => s.attributes[ATTR.spanType] === 'tool');
    expect(tools).toHaveLength(3);
    expect(tools[0]?.status.code).toBe('OK');
    expect(tools[1]?.status.code).toBe('ERROR');
    expect(tools[2]?.status.code).toBe('ERROR');
    expect(tools[2]?.status.message).toMatch(/Unknown tool/);
  });

  it('textOnlyLoopModel never issues tool calls', async () => {
    const model = textOnlyLoopModel(() => Promise.resolve({ output: 'hi' }));
    const turn = await model({ model: 'm', messages: [], tools: [] });
    expect(turn.assistant).toBe('hi');
    expect(turn.toolCalls).toBeUndefined();
  });
});

describe('mcp adapter', () => {
  it('wraps MCP-style tools with spans and surfaces unknown tools', async () => {
    const recorder = new FlightRecorder({
      serviceName: 'unit',
      store: new MemoryTraceStore(),
      redactOnFlush: false,
    });
    const run = recorder.startRun('mcp');
    const agent = run.startAgent({ id: 'bot', role: 'bot' });
    const mcp = instrumentMcpTools(agent, [
      { name: 'add', execute: (args) => Number(args['a']) + Number(args['b']) },
      {
        name: 'boom',
        execute: () => {
          throw new Error('nope');
        },
      },
    ]);
    expect(await mcp.call('add', { a: 2, b: 3 }, 'c1')).toBe(5);
    await expect(mcp.call('boom', {})).rejects.toThrow('nope');
    await expect(mcp.call('ghost', {})).rejects.toThrow(/Unknown MCP tool/);
    agent.end();
    const trace = await recorder.flush(run);
    const tools = trace.spans.filter((s) => s.attributes[ATTR.spanType] === 'tool');
    expect(tools).toHaveLength(3);
    expect(tools[0]?.attributes[ATTR.toolResult]).toBe('5');
    expect(tools[1]?.status.code).toBe('ERROR');
    expect(tools[2]?.status.code).toBe('ERROR');
  });
});
