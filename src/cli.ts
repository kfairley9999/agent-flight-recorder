#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { diffRuns } from './diff.js';
import { toOtlpJson } from './otel.js';
import { redactTrace } from './redaction.js';
import { replayFrom } from './replay.js';
import { parseTrace } from './schema.js';
import { loadTraceFile, saveTraceFile } from './store.js';
import { ATTR, type Trace } from './types.js';
import { loadViewerAssets, renderStandaloneHtml, serveViewer } from './viewer-server.js';

const HELP = `Agent Flight Recorder — record, redact, replay, and diff multi-agent traces

Usage:
  afr inspect <trace.afr.json>
  afr view <trace.afr.json> [--port 4173] [--host 127.0.0.1]
  afr html <trace.afr.json> -o <out.html>
  afr redact <trace.afr.json> [--in-place] [-o <out.afr.json>]
  afr diff <left.afr.json> <right.afr.json> [--json]
  afr replay <trace.afr.json> [--from-step N] [-o <out.afr.json>]
  afr export-otlp <trace.afr.json> [-o <out.json>]
  afr --help
  afr --version

Replay in the CLI is a deterministic resimulation (recorded tool and model
outputs are stubbed). Hybrid / live-model replay is available from the SDK.
`;

export async function main(argv: string[]): Promise<number> {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h' || argv[0] === 'help') {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv[0] === '--version' || argv[0] === '-v' || argv[0] === 'version') {
    process.stdout.write('0.1.0\n');
    return 0;
  }

  const command = argv[0];
  const rest = argv.slice(1);

  try {
    switch (command) {
      case 'inspect':
        return await inspectCmd(rest);
      case 'view':
        return await viewCmd(rest);
      case 'html':
        return await htmlCmd(rest);
      case 'redact':
        return await redactCmd(rest);
      case 'diff':
        return await diffCmd(rest);
      case 'replay':
        return await replayCmd(rest);
      case 'export-otlp':
      case 'export':
        return await exportCmd(rest);
      default:
        process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
        return 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Error: ${message}\n`);
    return 1;
  }
}

async function inspectCmd(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true, options: {} });
  const file = requirePositional(positionals[0], 'inspect <trace.afr.json>');
  const trace = await loadTraceFile(resolve(file));
  const counts = countTypes(trace);
  const lines = [
    `run:        ${trace.run.name} (${trace.run.id})`,
    `status:     ${trace.run.status}`,
    `started:    ${trace.run.startedAt}`,
    `ended:      ${trace.run.endedAt ?? '(open)'}`,
    `spans:      ${trace.spans.length}`,
    `  agents:   ${counts.agent}`,
    `  llm:      ${counts.llm}`,
    `  tools:    ${counts.tool}`,
    `  decisions:${counts.decision}`,
    `redaction:  ${trace.redaction.applied ? `yes (${trace.redaction.redactedCount} hits; ${trace.redaction.rulesTriggered.join(', ') || 'no rules'})` : 'not applied'}`,
    '',
    'timeline:',
  ];
  const spans = [...trace.spans].sort(
    (a, b) => Number(a.startTimeUnixNano) - Number(b.startTimeUnixNano),
  );
  for (const span of spans) {
    const type = String(span.attributes[ATTR.spanType] ?? span.kind);
    const step = span.attributes[ATTR.stepIndex];
    const agent = span.attributes[ATTR.agentId];
    const who = typeof agent === 'string' ? ` [${agent}]` : '';
    const stepLabel = typeof step === 'number' ? String(step) : '-';
    lines.push(
      `  #${stepLabel}  ${type.padEnd(9)} ${span.status.code.padEnd(5)} ${span.name}${who}`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

async function viewCmd(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      port: { type: 'string', default: '4173' },
      host: { type: 'string', default: '127.0.0.1' },
    },
  });
  const file = requirePositional(positionals[0], 'view <trace.afr.json>');
  const trace = await loadTraceFile(resolve(file));
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid port: ${values.port}`);
  }
  const server = await serveViewer({ trace, port, host: values.host });
  process.stdout.write(`Viewer: ${server.url}\nTrace:  ${file}\nPress Ctrl+C to stop.\n`);
  await new Promise<void>((resolveDone) => {
    const stop = () => {
      void server.close().finally(() => resolveDone());
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  });
  return 0;
}

async function htmlCmd(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { o: { type: 'string', short: 'o' } },
  });
  const file = requirePositional(positionals[0], 'html <trace.afr.json> -o <out.html>');
  if (!values.o) {
    throw new Error('html requires -o <out.html>');
  }
  const trace = await loadTraceFile(resolve(file));
  const assets = await loadViewerAssets();
  const html = renderStandaloneHtml(assets.html, assets.css, assets.js, trace);
  const out = resolve(values.o);
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, html, 'utf8');
  process.stdout.write(`Wrote ${out}\n`);
  return 0;
}

async function redactCmd(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      o: { type: 'string', short: 'o' },
      'in-place': { type: 'boolean', default: false },
    },
  });
  const file = requirePositional(positionals[0], 'redact <trace.afr.json>');
  const path = resolve(file);
  const raw = await loadTraceFile(path);
  const redacted = redactTrace(raw);
  const out = values['in-place'] ? path : values.o ? resolve(values.o) : undefined;
  if (!out) {
    process.stdout.write(`${JSON.stringify(redacted, null, 2)}\n`);
    return 0;
  }
  await saveTraceFile(out, redacted);
  process.stdout.write(
    `Wrote ${out} (redacted ${redacted.redaction.redactedCount} values; rules: ${redacted.redaction.rulesTriggered.join(', ') || 'none'})\n`,
  );
  return 0;
}

async function diffCmd(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { json: { type: 'boolean', default: false } },
  });
  const leftPath = requirePositional(positionals[0], 'diff <left.afr.json> <right.afr.json>');
  const rightPath = requirePositional(positionals[1], 'diff <left.afr.json> <right.afr.json>');
  const left = await loadTraceFile(resolve(leftPath));
  const right = await loadTraceFile(resolve(rightPath));
  const diff = diffRuns(left, right);
  if (values.json) {
    process.stdout.write(`${JSON.stringify(diff, null, 2)}\n`);
  } else if (diff.equal) {
    process.stdout.write(`Runs are equivalent (${diff.summary.compared} spans compared).\n`);
  } else {
    const first = diff.firstDivergence;
    process.stdout.write(`Runs diverged (${diff.summary.changed} difference(s)).\n`);
    if (first) {
      process.stdout.write(
        `First: ${first.kind} at ${first.leftPath}\n  left:  ${first.left ?? '(none)'}\n  right: ${first.right ?? '(none)'}\n`,
      );
    }
  }
  return diff.equal ? 0 : 2;
}

async function replayCmd(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      o: { type: 'string', short: 'o' },
      'from-step': { type: 'string', default: '0' },
    },
  });
  const file = requirePositional(positionals[0], 'replay <trace.afr.json>');
  const trace = await loadTraceFile(resolve(file));
  const fromStep = Number(values['from-step']);
  if (!Number.isInteger(fromStep) || fromStep < 0) {
    throw new Error(`Invalid --from-step: ${values['from-step']}`);
  }
  const harness = replayFrom(trace, { mode: 'deterministic', fromStep });
  const next = await harness.resimulate();
  if (values.o) {
    await saveTraceFile(resolve(values.o), next);
    process.stdout.write(`Wrote replay trace to ${values.o} (run ${next.run.id})\n`);
  } else {
    process.stdout.write(`${JSON.stringify(next, null, 2)}\n`);
  }
  return 0;
}

async function exportCmd(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { o: { type: 'string', short: 'o' } },
  });
  // Allow `afr export otlp file` as well as `afr export-otlp file`
  const filtered = positionals.filter((item) => item !== 'otlp' && item !== 'otel');
  const file = requirePositional(filtered[0], 'export-otlp <trace.afr.json>');
  const trace = await loadTraceFile(resolve(file));
  const doc = toOtlpJson(trace);
  const json = `${JSON.stringify(doc, null, 2)}\n`;
  if (values.o) {
    const out = resolve(values.o);
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, json, 'utf8');
    process.stdout.write(`Wrote ${out}\n`);
  } else {
    process.stdout.write(json);
  }
  return 0;
}

function requirePositional(value: string | undefined, usage: string): string {
  if (!value) {
    throw new Error(`Missing argument. Usage: afr ${usage}`);
  }
  return value;
}

function countTypes(trace: Trace): Record<string, number> {
  const counts: Record<string, number> = { agent: 0, llm: 0, tool: 0, decision: 0, run: 0 };
  for (const span of trace.spans) {
    const type = String(span.attributes[ATTR.spanType] ?? 'other');
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return counts;
}

function isDirectRun(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  return /[\\/]cli\.(ts|js)$/.test(entry);
}

if (isDirectRun()) {
  void main(process.argv.slice(2)).then((code) => process.exit(code));
}

export { parseTrace };
