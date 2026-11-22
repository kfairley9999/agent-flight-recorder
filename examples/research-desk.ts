/**
 * Multi-agent demo: planner → researcher → writer → critic → writer revision.
 *
 * Everything is scripted (no network, no API keys). Running this file writes
 * examples/traces/research-desk.afr.json — a real recorded trace used by the
 * viewer, tests, and the GitHub Pages demo.
 */
import { mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FlightRecorder,
  FileTraceStore,
  instrumentMcpTools,
  runToolLoop,
  type LoopModel,
} from '../src/index.js';

const ROOT = dirname(fileURLToPath(import.meta.url));
const TRACE_DIR = join(ROOT, 'traces');

const PAPERS = [
  {
    title: 'When Agent Teams Drift: Measuring Handoff Failures',
    year: 2026,
    venue: 'Workshop on Agent Reliability',
    summary:
      'Defines a handoff-failure rate for multi-agent runs and shows most errors start at the planner-to-researcher boundary.',
  },
  {
    title: 'Trace-Level Evals for Tool-Using Agents',
    year: 2025,
    venue: 'Findings of EMNLP',
    summary:
      'Argues that single-turn accuracy hides tool-loop regressions, and proposes span-aligned evals over traces.',
  },
  {
    title: 'Least Privilege for Tool-Calling Agents',
    year: 2026,
    venue: 'Preprint',
    summary:
      'A permission layer that blocks out-of-policy tool calls, including those induced by prompt injection.',
  },
];

const scriptedPlanner: LoopModel = () => ({
  assistant: JSON.stringify({
    goal: 'Brief on open-source agent evaluation, with emphasis on multi-agent reliability.',
    queries: ['multi-agent evaluation handoff failures', 'trace-level evals for tool-using agents'],
  }),
  finishReason: 'stop',
});

const scriptedResearcher: LoopModel = (request) => {
  const last = request.messages[request.messages.length - 1];
  const hasToolResult = request.messages.some((m) => m.role === 'tool');
  if (!hasToolResult) {
    return {
      assistant: 'I will search the catalog and fetch the top papers.',
      toolCalls: [
        {
          name: 'catalog_search',
          arguments: { q: last?.content ?? 'agent evaluation' },
          callId: 'c1',
        },
      ],
      finishReason: 'tool_calls',
    };
  }
  const fetched = request.messages.filter((m) => m.role === 'tool').length;
  if (fetched === 1) {
    return {
      assistant: 'Fetching the first paper abstract.',
      toolCalls: [
        { name: 'fetch_abstract', arguments: { title: PAPERS[0]?.title }, callId: 'c2' },
        {
          name: 'fetch_abstract',
          arguments: { title: 'Missing Paper That Should 404' },
          callId: 'c3',
        },
      ],
      finishReason: 'tool_calls',
    };
  }
  return {
    assistant:
      'Notes: (1) Handoff failures dominate multi-agent error budgets. (2) Trace-level evals catch tool-loop regressions that single-turn scores miss. (3) Least-privilege tool firewalls are a practical mitigation.',
    finishReason: 'stop',
  };
};

const scriptedWriter =
  (revision: boolean): LoopModel =>
  () => {
    if (!revision) {
      return {
        assistant:
          'Draft v1: Multi-agent systems fail most often at handoffs, not inside a single model call. Teams should record traces, grade them at span level, and restrict tools by default. Contact: jane.doe@example.com.',
        finishReason: 'stop',
      };
    }
    return {
      assistant:
        'Draft v2: Multi-agent systems fail most often at handoffs, not inside a single model call. Record every message, tool call, and decision; grade runs at span level; and give each agent least-privilege tool access. (Contact redacted in the stored trace.)',
      finishReason: 'stop',
    };
  };

const scriptedCritic: LoopModel = () => ({
  assistant:
    'The draft leaks a contact email and should not end on a personal address. Request a revision that keeps the technical claims and drops the contact line.',
  finishReason: 'stop',
});

export async function runResearchDesk(outDir: string = TRACE_DIR): Promise<string> {
  const recorder = new FlightRecorder({
    serviceName: 'research-desk',
    serviceVersion: '0.1.0',
    store: new FileTraceStore(outDir),
    redaction: { enabled: true },
  });

  const run = recorder.startRun('open-source-agent-evals-brief');

  const planner = run.startAgent({ id: 'planner', role: 'planner' });
  planner.addMessage({
    role: 'system',
    content: 'You plan research briefs for a small evaluation team. Return a JSON plan.',
  });
  planner.addMessage({
    role: 'user',
    content:
      'Please write a short brief on recent open-source work in agent evaluation, especially multi-agent reliability. If you need me, call 415-555-0198 or jane.doe@example.com.',
  });
  await run.withAgent(planner, () =>
    runToolLoop({
      run,
      agent: planner,
      model: 'scripted-planner',
      provider: 'demo',
      tools: [],
      complete: scriptedPlanner,
      maxTurns: 1,
    }),
  );
  planner.recordDecision({
    type: 'delegate',
    summary: 'Hand the queries to the researcher, then write and review a brief.',
    data: { next: 'researcher' },
  });
  planner.end();

  const researcher = run.startAgent({ id: 'researcher', role: 'researcher' });
  run.linkTo(researcher, planner, 'handoff');
  researcher.addMessage({
    role: 'system',
    content: 'You research papers using the catalog tools and write concise notes.',
  });
  researcher.addMessage({
    role: 'user',
    content: 'Investigate multi-agent evaluation and trace-level evals. Use the catalog.',
  });

  const mcp = instrumentMcpTools(researcher, [
    {
      name: 'catalog_search',
      description: 'Search the local paper catalog',
      execute: (args) => ({
        query: args['q'],
        hits: PAPERS.map((paper) => ({ title: paper.title, year: paper.year, venue: paper.venue })),
      }),
    },
    {
      name: 'fetch_abstract',
      description: 'Fetch a stored abstract by title',
      execute: (args) => {
        const raw = args['title'];
        const title = typeof raw === 'string' ? raw : '';
        const paper = PAPERS.find((item) => item.title === title);
        if (!paper) {
          throw new Error(`Abstract not found: ${title}`);
        }
        return paper;
      },
    },
  ]);

  await run.withAgent(researcher, () =>
    runToolLoop({
      run,
      agent: researcher,
      model: 'scripted-researcher',
      provider: 'demo',
      tools: mcp.tools.map((tool) => {
        const def: { name: string; description?: string; handler: typeof tool.execute } = {
          name: tool.name,
          handler: tool.execute,
        };
        if (tool.description !== undefined) def.description = tool.description;
        return def;
      }),
      complete: scriptedResearcher,
      maxTurns: 4,
    }),
  );
  researcher.end();

  const writer = run.startAgent({ id: 'writer', role: 'writer' });
  run.linkTo(writer, researcher, 'uses_result');
  writer.addMessage({
    role: 'system',
    content: 'Write a tight technical brief from the researcher notes.',
  });
  writer.addMessage({
    role: 'user',
    content: 'Draft a one-paragraph brief. You may include a contact line.',
  });
  await run.withAgent(writer, () =>
    runToolLoop({
      run,
      agent: writer,
      model: 'scripted-writer',
      provider: 'demo',
      tools: [],
      complete: scriptedWriter(false),
      maxTurns: 1,
    }),
  );
  writer.end();

  const critic = run.startAgent({ id: 'critic', role: 'critic' });
  run.linkTo(critic, writer, 'handoff');
  critic.addMessage({
    role: 'system',
    content: 'Review the draft for accuracy and for leaked personal data.',
  });
  critic.addMessage({
    role: 'user',
    content: 'Review draft v1 and decide whether to accept or revise.',
  });
  await run.withAgent(critic, () =>
    runToolLoop({
      run,
      agent: critic,
      model: 'scripted-critic',
      provider: 'demo',
      tools: [],
      complete: scriptedCritic,
      maxTurns: 1,
    }),
  );
  critic.recordDecision({
    type: 'request_revision',
    summary: 'Drop the contact email and keep the technical claims.',
    data: { attempt: 2 },
  });
  critic.end();

  const revision = run.startAgent({
    id: 'writer',
    role: 'writer',
    name: 'agent:writer:revision',
    attributes: { 'afr.agent.attempt': 2 },
  });
  run.linkTo(revision, critic, 'caused_by');
  revision.addMessage({
    role: 'system',
    content: 'Revise the brief. Do not include personal contact information.',
  });
  revision.addMessage({ role: 'user', content: 'Please produce draft v2 without a contact line.' });
  await run.withAgent(revision, () =>
    runToolLoop({
      run,
      agent: revision,
      model: 'scripted-writer',
      provider: 'demo',
      tools: [],
      complete: scriptedWriter(true),
      maxTurns: 1,
    }),
  );
  revision.end();

  run.end();
  const trace = await recorder.flush(run);
  await mkdir(outDir, { recursive: true });
  return join(outDir, `${trace.run.id}.afr.json`);
}

export async function writeCanonicalTrace(): Promise<string> {
  // Re-run into a temp store, then we keep whatever flush wrote. For the
  // checked-in demo we write a stable filename regardless of run id.
  const { saveTraceFile, loadTraceFile } = await import('../src/index.js');
  const path = await runResearchDesk(TRACE_DIR);
  const written = await loadTraceFile(path);
  const canonical = join(TRACE_DIR, 'research-desk.afr.json');
  await saveTraceFile(canonical, written);
  if (path !== canonical) {
    await rm(path, { force: true });
  }
  return canonical;
}

const entry = process.argv[1];
if (entry && /research-desk\.(ts|js)$/.test(entry)) {
  writeCanonicalTrace()
    .then((path) => {
      process.stdout.write(`Wrote ${path}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
