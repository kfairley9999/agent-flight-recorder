import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseTrace } from './schema.js';
import type { Trace } from './types.js';

export interface TraceStore {
  save(trace: Trace): Promise<void>;
  load(runId: string): Promise<Trace | undefined>;
  list(): Promise<string[]>;
}

export class MemoryTraceStore implements TraceStore {
  private readonly traces = new Map<string, Trace>();

  save(trace: Trace): Promise<void> {
    this.traces.set(trace.run.id, structuredClone(trace));
    return Promise.resolve();
  }

  load(runId: string): Promise<Trace | undefined> {
    const found = this.traces.get(runId);
    return Promise.resolve(found ? structuredClone(found) : undefined);
  }

  list(): Promise<string[]> {
    return Promise.resolve([...this.traces.keys()]);
  }

  clear(): void {
    this.traces.clear();
  }
}

export class FileTraceStore implements TraceStore {
  constructor(private readonly directory: string) {}

  async save(trace: Trace): Promise<void> {
    const path = this.pathFor(trace.run.id);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
  }

  async load(runId: string): Promise<Trace | undefined> {
    try {
      const raw = await readFile(this.pathFor(runId), 'utf8');
      return parseTrace(JSON.parse(raw) as unknown);
    } catch (error) {
      if (isEnoent(error)) {
        return undefined;
      }
      throw error;
    }
  }

  async list(): Promise<string[]> {
    try {
      const names = await readdir(this.directory);
      return names
        .filter((name) => name.endsWith('.afr.json'))
        .map((name) => name.slice(0, -'.afr.json'.length))
        .sort();
    } catch (error) {
      if (isEnoent(error)) {
        return [];
      }
      throw error;
    }
  }

  pathFor(runId: string): string {
    const safe = runId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return join(this.directory, `${safe}.afr.json`);
  }
}

export async function loadTraceFile(path: string): Promise<Trace> {
  const raw = await readFile(path, 'utf8');
  return parseTrace(JSON.parse(raw) as unknown);
}

export async function saveTraceFile(path: string, trace: Trace): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
}

function isEnoent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
