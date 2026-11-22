import { AsyncLocalStorage } from 'node:async_hooks';
import type { MutableSpan } from './span.js';
import type { RunSession } from './run.js';

export interface RecorderScope {
  run: RunSession;
  span: MutableSpan;
}

export const recorderContext = new AsyncLocalStorage<RecorderScope>();

export function currentScope(): RecorderScope | undefined {
  return recorderContext.getStore();
}

export function runWithScope<T>(scope: RecorderScope, fn: () => T): T {
  return recorderContext.run(scope, fn);
}
