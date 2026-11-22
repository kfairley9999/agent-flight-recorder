import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runResearchDesk } from '../examples/research-desk.js';
import { loadTraceFile, parseTrace, replayFrom, diffRuns, ATTR } from '../src/index.js';

describe('research-desk example', () => {
  it('records a four-agent run, redacts PII, and deterministically resimulates', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'afr-demo-'));
    try {
      const path = await runResearchDesk(dir);
      const trace = parseTrace(await loadTraceFile(path));
      const types = trace.spans.map((s) => s.attributes[ATTR.spanType]);
      expect(types).toContain('agent');
      expect(types).toContain('llm');
      expect(types).toContain('tool');
      expect(types).toContain('decision');

      const agents = new Set(
        trace.spans
          .filter((s) => s.attributes[ATTR.spanType] === 'agent')
          .map((s) => s.attributes[ATTR.agentId]),
      );
      expect(agents).toEqual(new Set(['planner', 'researcher', 'writer', 'critic']));

      const blob = JSON.stringify(trace);
      expect(blob).not.toContain('jane.doe@example.com');
      expect(blob).not.toContain('415-555-0198');
      expect(blob).toContain('[REDACTED:email]');
      expect(blob).toContain('[REDACTED:phone]');
      expect(trace.redaction.applied).toBe(true);

      const failedTool = trace.spans.find(
        (s) => s.attributes[ATTR.spanType] === 'tool' && s.status.code === 'ERROR',
      );
      expect(failedTool).toBeTruthy();

      const copy = await replayFrom(trace).resimulate({ serviceName: 'research-desk' });
      // Resimulation starts from already-redacted payloads, so payloads should match.
      const diff = diffRuns(trace, copy);
      expect(diff.equal).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
