import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { main } from '../src/cli.js';
import { FlightRecorder } from '../src/recorder.js';
import { MemoryTraceStore, saveTraceFile } from '../src/store.js';
import { serveViewer, renderStandaloneHtml, loadViewerAssets } from '../src/viewer-server.js';

async function writeSample(dir: string, name = 'a.afr.json', output = 'hello') {
  const recorder = new FlightRecorder({
    serviceName: 'cli',
    store: new MemoryTraceStore(),
    redactOnFlush: false,
  });
  const run = recorder.startRun('cli-run');
  const agent = run.startAgent({ id: 'a', role: 'a' });
  agent.addMessage({ role: 'user', content: 'secret jane.doe@example.com' });
  agent.startLlmCall({ model: 'm' }).end({ output });
  agent.end();
  const trace = await recorder.flush(run);
  const path = join(dir, name);
  await saveTraceFile(path, trace);
  return { path, trace };
}

async function withStdout(argv: string[]) {
  const logs: string[] = [];
  const errs: string[] = [];
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    logs.push(String(chunk));
    return true;
  });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    errs.push(String(chunk));
    return true;
  });
  try {
    const code = await main(argv);
    return { code, stdout: logs.join(''), stderr: errs.join('') };
  } finally {
    out.mockRestore();
    err.mockRestore();
  }
}

describe('CLI', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function tmp() {
    const dir = await mkdtemp(join(tmpdir(), 'afr-cli-'));
    dirs.push(dir);
    return dir;
  }

  it('prints help and version', async () => {
    const help = await withStdout(['--help']);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/Usage/);
    const version = await withStdout(['--version']);
    expect(version.stdout).toMatch(/0\.1\.0/);
    const unknown = await withStdout(['nope']);
    expect(unknown.code).toBe(1);
  });

  it('inspects, redacts, diffs, replays, and exports', async () => {
    const dir = await tmp();
    const a = await writeSample(dir, 'a.afr.json', 'hello');
    const b = await writeSample(dir, 'b.afr.json', 'other');

    const inspect = await withStdout(['inspect', a.path]);
    expect(inspect.code).toBe(0);
    expect(inspect.stdout).toMatch(/cli-run/);
    expect(inspect.stdout).toMatch(/agents:/);

    const redactedPath = join(dir, 'redacted.afr.json');
    const redact = await withStdout(['redact', a.path, '-o', redactedPath]);
    expect(redact.code).toBe(0);
    const redacted = await readFile(redactedPath, 'utf8');
    expect(redacted).toContain('[REDACTED:email]');
    expect(redacted).not.toContain('jane.doe@example.com');

    const same = await withStdout(['diff', a.path, a.path]);
    expect(same.code).toBe(0);
    const different = await withStdout(['diff', a.path, b.path]);
    expect(different.code).toBe(2);
    expect(different.stdout).toMatch(/diverged/);
    const asJson = await withStdout(['diff', a.path, b.path, '--json']);
    expect(asJson.stdout).toMatch(/"equal": false/);

    const replayOut = join(dir, 'replay.afr.json');
    const replay = await withStdout(['replay', a.path, '-o', replayOut]);
    expect(replay.code).toBe(0);
    const replayed = JSON.parse(await readFile(replayOut, 'utf8')) as { spans: unknown[] };
    expect(replayed.spans.length).toBeGreaterThan(0);

    const otlp = await withStdout(['export-otlp', a.path]);
    expect(otlp.code).toBe(0);
    expect(otlp.stdout).toMatch(/resourceSpans/);
    const otlpPath = join(dir, 'otlp.json');
    expect((await withStdout(['export', 'otlp', a.path, '-o', otlpPath])).code).toBe(0);
    const exported = JSON.parse(await readFile(otlpPath, 'utf8')) as { resourceSpans: unknown };
    expect(exported.resourceSpans).toBeTruthy();
  });

  it('writes a standalone HTML file and serves the viewer', async () => {
    const dir = await tmp();
    const { path, trace } = await writeSample(dir);
    const htmlPath = join(dir, 'out.html');
    const html = await withStdout(['html', path, '-o', htmlPath]);
    expect(html.code).toBe(0);
    const contents = await readFile(htmlPath, 'utf8');
    expect(contents).toContain('window.AFR_TRACE');
    expect(contents).toContain('Agent Flight Recorder');

    const server = await serveViewer({ trace, port: 0, host: '127.0.0.1' });
    expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//);
    const page = await fetch(server.url);
    expect(page.ok).toBe(true);
    expect(await page.text()).toContain('Agent Flight Recorder');
    const json = await fetch(new URL('trace.json', server.url));
    const body = (await json.json()) as { run: { id: string } };
    expect(body.run.id).toBe(trace.run.id);
    const missing = await fetch(new URL('nope.js', server.url));
    expect(missing.status).toBe(404);
    await server.close();
  });

  it('returns an error for a missing inspect file', async () => {
    const result = await withStdout(['inspect', '/tmp/does-not-exist-afr.json']);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Error:/);
  });

  it('renderStandaloneHtml escapes HTML in traces', async () => {
    const assets = await loadViewerAssets();
    const recorder = new FlightRecorder({
      serviceName: 'unit',
      store: new MemoryTraceStore(),
      redactOnFlush: false,
    });
    const run = recorder.startRun('x');
    run.end();
    const trace = await recorder.flush(run);
    const html = renderStandaloneHtml(assets.html, assets.css, assets.js, trace);
    expect(html).toContain('<style>');
    expect(html).toContain('window.AFR_TRACE');
    await writeFile(join(tmpdir(), 'afr-ignore.txt'), 'ok');
  });
});
