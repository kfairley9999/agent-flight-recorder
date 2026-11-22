import { ATTR, EVENT, type Span, type Trace } from './types.js';

export type DivergenceKind =
  | 'span_missing'
  | 'span_added'
  | 'status'
  | 'attribute'
  | 'message'
  | 'tool_args'
  | 'tool_result'
  | 'llm_output'
  | 'decision';

export interface Divergence {
  kind: DivergenceKind;
  stepIndex: number;
  leftPath: string;
  rightPath: string;
  left?: string;
  right?: string;
}

export interface RunDiff {
  equal: boolean;
  leftRunId: string;
  rightRunId: string;
  firstDivergence?: Divergence;
  divergences: Divergence[];
  summary: {
    leftSpans: number;
    rightSpans: number;
    compared: number;
    changed: number;
  };
}

const IGNORED_ATTRIBUTES = new Set([ATTR.outputHash, ATTR.argumentHash, 'telemetry.sdk.version']);

export function diffRuns(left: Trace, right: Trace): RunDiff {
  const leftSpans = comparableSpans(left);
  const rightSpans = comparableSpans(right);
  const aligned = align(leftSpans, rightSpans);
  const divergences: Divergence[] = [];

  for (const [a, b] of aligned) {
    if (!a && b) {
      divergences.push({
        kind: 'span_added',
        stepIndex: stepOf(b),
        leftPath: '(missing)',
        rightPath: pathOf(b),
        right: signatureOf(b),
      });
      continue;
    }
    if (a && !b) {
      divergences.push({
        kind: 'span_missing',
        stepIndex: stepOf(a),
        leftPath: pathOf(a),
        rightPath: '(missing)',
        left: signatureOf(a),
      });
      continue;
    }
    if (a && b) {
      divergences.push(...comparePair(a, b));
    }
  }

  const first = divergences[0];
  const diff: RunDiff = {
    equal: divergences.length === 0,
    leftRunId: left.run.id,
    rightRunId: right.run.id,
    divergences,
    summary: {
      leftSpans: leftSpans.length,
      rightSpans: rightSpans.length,
      compared: aligned.length,
      changed: divergences.length,
    },
  };
  if (first) {
    diff.firstDivergence = first;
  }
  return diff;
}

function comparableSpans(trace: Trace): Span[] {
  return [...trace.spans]
    .filter((span) => span.attributes[ATTR.spanType] !== 'run')
    .sort((a, b) => {
      const step = stepOf(a) - stepOf(b);
      if (step !== 0) {
        return step;
      }
      return a.name.localeCompare(b.name);
    });
}

function align(left: Span[], right: Span[]): Array<[Span | undefined, Span | undefined]> {
  const n = left.length;
  const m = right.length;
  const table: number[][] = Array.from({ length: n + 1 }, () => Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = table[i];
    const nextRow = table[i + 1];
    const leftSpan = left[i];
    if (!row || !nextRow || !leftSpan) {
      continue;
    }
    for (let j = m - 1; j >= 0; j -= 1) {
      const rightSpan = right[j];
      const diag = nextRow[j + 1] ?? 0;
      const down = nextRow[j] ?? 0;
      const across = row[j + 1] ?? 0;
      if (rightSpan && signatureOf(leftSpan) === signatureOf(rightSpan)) {
        row[j] = 1 + diag;
      } else {
        row[j] = Math.max(down, across);
      }
    }
  }
  const pairs: Array<[Span | undefined, Span | undefined]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    const a = left[i];
    const b = right[j];
    if (a && b && signatureOf(a) === signatureOf(b)) {
      pairs.push([a, b]);
      i += 1;
      j += 1;
      continue;
    }
    const down = table[i + 1]?.[j] ?? 0;
    const across = table[i]?.[j + 1] ?? 0;
    if (down >= across) {
      pairs.push([a, undefined]);
      i += 1;
    } else {
      pairs.push([undefined, b]);
      j += 1;
    }
  }
  while (i < n) {
    pairs.push([left[i], undefined]);
    i += 1;
  }
  while (j < m) {
    pairs.push([undefined, right[j]]);
    j += 1;
  }
  return pairs;
}

function comparePair(left: Span, right: Span): Divergence[] {
  const found: Divergence[] = [];
  const path = pathOf(left);
  const step = stepOf(left);

  if (
    left.status.code !== right.status.code ||
    (left.status.message ?? '') !== (right.status.message ?? '')
  ) {
    found.push({
      kind: 'status',
      stepIndex: step,
      leftPath: path,
      rightPath: pathOf(right),
      left: `${left.status.code}${left.status.message ? `: ${left.status.message}` : ''}`,
      right: `${right.status.code}${right.status.message ? `: ${right.status.message}` : ''}`,
    });
  }

  const type = String(left.attributes[ATTR.spanType] ?? '');
  if (type === 'tool') {
    pushIfChanged(
      found,
      'tool_args',
      step,
      path,
      pathOf(right),
      attr(left, ATTR.toolArguments),
      attr(right, ATTR.toolArguments),
    );
    pushIfChanged(
      found,
      'tool_result',
      step,
      path,
      pathOf(right),
      attr(left, ATTR.toolResult),
      attr(right, ATTR.toolResult),
    );
  }
  if (type === 'llm') {
    pushIfChanged(
      found,
      'llm_output',
      step,
      path,
      pathOf(right),
      attr(left, ATTR.genAiOutput),
      attr(right, ATTR.genAiOutput),
    );
  }
  if (type === 'decision') {
    pushIfChanged(
      found,
      'decision',
      step,
      path,
      pathOf(right),
      `${attr(left, ATTR.decisionType)}:${attr(left, ATTR.decisionSummary)}`,
      `${attr(right, ATTR.decisionType)}:${attr(right, ATTR.decisionSummary)}`,
    );
  }

  const leftMessages = messagesOf(left);
  const rightMessages = messagesOf(right);
  const max = Math.max(leftMessages.length, rightMessages.length);
  for (let i = 0; i < max; i += 1) {
    const lm = leftMessages[i];
    const rm = rightMessages[i];
    if (lm !== rm) {
      const item: Divergence = {
        kind: 'message',
        stepIndex: step,
        leftPath: `${path}#message[${i}]`,
        rightPath: `${pathOf(right)}#message[${i}]`,
      };
      if (lm !== undefined) item.left = lm;
      if (rm !== undefined) item.right = rm;
      found.push(item);
    }
  }

  const keys = new Set([...Object.keys(left.attributes), ...Object.keys(right.attributes)]);
  for (const key of keys) {
    if (IGNORED_ATTRIBUTES.has(key) || key === ATTR.stepIndex) {
      continue;
    }
    if (
      key === ATTR.toolArguments ||
      key === ATTR.toolResult ||
      key === ATTR.genAiOutput ||
      key === ATTR.decisionSummary ||
      key === ATTR.decisionType ||
      key === ATTR.decisionData
    ) {
      continue;
    }
    const lv = stringifyAttr(left.attributes[key]);
    const rv = stringifyAttr(right.attributes[key]);
    if (lv !== rv) {
      found.push({
        kind: 'attribute',
        stepIndex: step,
        leftPath: `${path}.${key}`,
        rightPath: `${pathOf(right)}.${key}`,
        left: lv,
        right: rv,
      });
    }
  }

  return found;
}

function pushIfChanged(
  found: Divergence[],
  kind: DivergenceKind,
  stepIndex: number,
  leftPath: string,
  rightPath: string,
  left: string | undefined,
  right: string | undefined,
): void {
  if ((left ?? '') !== (right ?? '')) {
    const item: Divergence = { kind, stepIndex, leftPath, rightPath };
    if (left !== undefined) {
      item.left = left;
    }
    if (right !== undefined) {
      item.right = right;
    }
    found.push(item);
  }
}

function messagesOf(span: Span): string[] {
  return span.events
    .filter((event) => event.name === EVENT.message)
    .map((event) => {
      const role = String(event.attributes?.[ATTR.messageRole] ?? '');
      const content = String(event.attributes?.[ATTR.messageContent] ?? '');
      return `${role}: ${content}`;
    });
}

function signatureOf(span: Span): string {
  const type = String(span.attributes[ATTR.spanType] ?? 'unknown');
  const agent = String(span.attributes[ATTR.agentId] ?? '');
  const tool = String(span.attributes[ATTR.toolName] ?? '');
  const model = String(span.attributes[ATTR.genAiModel] ?? '');
  const decision = String(span.attributes[ATTR.decisionType] ?? '');
  return `${type}|${agent}|${span.name}|${tool}|${model}|${decision}`;
}

function pathOf(span: Span): string {
  const type = String(span.attributes[ATTR.spanType] ?? 'span');
  const agent = span.attributes[ATTR.agentId];
  const agentPart = typeof agent === 'string' ? `${agent}/` : '';
  return `${agentPart}${type}:${span.name}@${stepOf(span)}`;
}

function stepOf(span: Span): number {
  const value = span.attributes[ATTR.stepIndex];
  return typeof value === 'number' ? value : -1;
}

function attr(span: Span, key: string): string | undefined {
  const value = span.attributes[key];
  return value === undefined ? undefined : String(value);
}

function stringifyAttr(value: unknown): string {
  if (value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}
