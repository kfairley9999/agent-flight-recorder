import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Trace } from './types.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export function viewerRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // In production the compiled file lives in dist/; sources keep viewer/ at repo root.
  return join(here, '..', 'viewer');
}

export function renderStandaloneHtml(
  viewerHtml: string,
  css: string,
  js: string,
  trace: Trace,
): string {
  const payload = JSON.stringify(trace).replace(/</g, '\\u003c');
  return viewerHtml
    .replace('<link rel="stylesheet" href="./styles.css" />', `<style>\n${css}\n</style>`)
    .replace(
      '<script src="./app.js"></script>',
      `<script>window.AFR_TRACE = ${payload};</script>\n<script>\n${js}\n</script>`,
    );
}

export async function loadViewerAssets(root: string = viewerRoot()): Promise<{
  html: string;
  css: string;
  js: string;
}> {
  const [html, css, js] = await Promise.all([
    readFile(join(root, 'index.html'), 'utf8'),
    readFile(join(root, 'styles.css'), 'utf8'),
    readFile(join(root, 'app.js'), 'utf8'),
  ]);
  return { html, css, js };
}

export async function writeStandaloneHtml(
  write: (path: string, contents: string) => Promise<void>,
  outPath: string,
  trace: Trace,
  root?: string,
): Promise<void> {
  const assets = await loadViewerAssets(root);
  await write(outPath, renderStandaloneHtml(assets.html, assets.css, assets.js, trace));
}

export function serveViewer(options: {
  trace: Trace;
  port: number;
  host?: string;
  root?: string;
}): Promise<{ url: string; close: () => Promise<void> }> {
  const root = options.root ?? viewerRoot();
  const host = options.host ?? '127.0.0.1';
  const traceJson = `${JSON.stringify(options.trace, null, 2)}\n`;

  const server = createServer((req, res) => {
    void handle(req, res, root, traceJson);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : options.port;
      resolve({
        url: `http://${host}:${port}/`,
        close: () =>
          new Promise((done, fail) => {
            server.close((error) => (error ? fail(error) : done()));
          }),
      });
    });
  });
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  traceJson: string,
): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/trace.json') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(traceJson);
      return;
    }
    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const safe = join(root, requested.replace(/^\/+/, ''));
    if (!safe.startsWith(root)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const body = await readFile(safe);
    const type = MIME[extname(safe)] ?? 'application/octet-stream';
    res.writeHead(200, { 'content-type': type });
    res.end(body);
  } catch {
    res.writeHead(404).end('Not found');
  }
}
