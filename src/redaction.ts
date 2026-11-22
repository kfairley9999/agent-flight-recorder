import type { AttributeMap, AttributeValue, Span, Trace, TraceRedactionReport } from './types.js';

export interface RedactionRule {
  name: string;
  /** Applied to free-text strings. */
  pattern?: RegExp;
  replace?: string;
}

export interface RedactionOptions {
  enabled?: boolean;
  extraPatterns?: Array<{ name: string; pattern: RegExp; replace?: string }>;
  extraSensitiveKeys?: string[];
  /** Maximum recursion depth when a string value is itself JSON. Default 6. */
  maxDepth?: number;
}

const SENSITIVE_KEY =
  /^(authorization|proxy-authorization|x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|client[_-]?id|password|passwd|pwd|secret|private[_-]?key|ssh[_-]?key|cookie|set-cookie|session|aws_secret_access_key|aws_access_key_id|token)$/i;

const DEFAULT_RULES: RedactionRule[] = [
  {
    name: 'pem_private_key',
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replace: '[REDACTED:pem_private_key]',
  },
  {
    name: 'bearer_token',
    pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    replace: '[REDACTED:bearer_token]',
  },
  {
    name: 'anthropic_key',
    pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
    replace: '[REDACTED:anthropic_key]',
  },
  {
    name: 'openai_key',
    pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{16,}\b/g,
    replace: '[REDACTED:openai_key]',
  },
  { name: 'groq_key', pattern: /\bgsk_[A-Za-z0-9_-]{16,}\b/g, replace: '[REDACTED:groq_key]' },
  {
    name: 'github_token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{16,}\b/g,
    replace: '[REDACTED:github_token]',
  },
  {
    name: 'github_pat',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
    replace: '[REDACTED:github_pat]',
  },
  {
    name: 'slack_token',
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replace: '[REDACTED:slack_token]',
  },
  {
    name: 'aws_access_key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replace: '[REDACTED:aws_access_key]',
  },
  {
    name: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replace: '[REDACTED:jwt]',
  },
  {
    name: 'email',
    pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
    replace: '[REDACTED:email]',
  },
  {
    name: 'phone_us',
    pattern: /\b(?:\+1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g,
    replace: '[REDACTED:phone]',
  },
  {
    name: 'ssn',
    pattern: /\b(?!000|666|9\d{2})\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/g,
    replace: '[REDACTED:ssn]',
  },
];

const CC_CANDIDATE = /\b(?:\d[ -]*?){13,19}\b/g;

export function luhnOk(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) {
    return false;
  }
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const ch = digits[i];
    if (ch === undefined) {
      return false;
    }
    let n = Number(ch);
    if (alt) {
      n *= 2;
      if (n > 9) {
        n -= 9;
      }
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

export class Redactor {
  private readonly enabled: boolean;
  private readonly rules: RedactionRule[];
  private readonly extraKeys: RegExp[];
  private readonly maxDepth: number;
  private readonly triggered = new Set<string>();
  private count = 0;

  constructor(options: RedactionOptions = {}) {
    this.enabled = options.enabled ?? true;
    this.rules = [
      ...DEFAULT_RULES,
      ...(options.extraPatterns ?? []).map((p) => ({
        name: p.name,
        pattern: p.pattern,
        replace: p.replace ?? `[REDACTED:${p.name}]`,
      })),
    ];
    this.extraKeys = (options.extraSensitiveKeys ?? []).map(
      (key) => new RegExp(`^${escapeRegExp(key)}$`, 'i'),
    );
    this.maxDepth = options.maxDepth ?? 6;
  }

  report(): TraceRedactionReport {
    return {
      applied: this.enabled,
      rulesTriggered: [...this.triggered].sort(),
      redactedCount: this.count,
    };
  }

  reset(): void {
    this.triggered.clear();
    this.count = 0;
  }

  redactTrace(trace: Trace): Trace {
    if (!this.enabled) {
      return {
        ...trace,
        redaction: { applied: false, rulesTriggered: [], redactedCount: 0 },
      };
    }
    this.reset();
    const spans = trace.spans.map((span) => this.redactSpan(span));
    return {
      ...trace,
      resource: { attributes: this.redactAttributes(trace.resource.attributes) },
      spans,
      redaction: this.report(),
    };
  }

  redactSpan(span: Span): Span {
    return {
      ...span,
      attributes: this.redactAttributes(span.attributes),
      events: span.events.map((event) => {
        if (event.attributes) {
          return { ...event, attributes: this.redactAttributes(event.attributes) };
        }
        return { name: event.name, timeUnixNano: event.timeUnixNano };
      }),
      links: span.links.map((link) => {
        if (link.attributes) {
          return { ...link, attributes: this.redactAttributes(link.attributes) };
        }
        return { traceId: link.traceId, spanId: link.spanId };
      }),
    };
  }

  redactAttributes(attrs: AttributeMap): AttributeMap {
    const out: AttributeMap = {};
    for (const [key, value] of Object.entries(attrs)) {
      out[key] = this.redactAttribute(key, value);
    }
    return out;
  }

  redactString(value: string, key?: string): string {
    return this.walkString(value, key, 0);
  }

  private redactAttribute(key: string, value: AttributeValue): AttributeValue {
    if (this.isSensitiveKey(key)) {
      this.note('sensitive_key');
      if (Array.isArray(value)) {
        return value.map(() => '[REDACTED:sensitive_key]');
      }
      return '[REDACTED:sensitive_key]';
    }
    if (typeof value === 'string') {
      return this.walkString(value, key, 0);
    }
    if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      return value.map((item) => this.walkString(item, key, 0));
    }
    return value;
  }

  private isSensitiveKey(key: string): boolean {
    const leaf = key.includes('.') ? (key.split('.').pop() ?? key) : key;
    if (SENSITIVE_KEY.test(leaf) || SENSITIVE_KEY.test(key)) {
      return true;
    }
    return this.extraKeys.some((re) => re.test(leaf) || re.test(key));
  }

  private walkString(value: string, key: string | undefined, depth: number): string {
    const trimmed = value.trim();
    if (depth < this.maxDepth && looksLikeJson(trimmed)) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        const walked = this.walkUnknown(parsed, key, depth + 1);
        return JSON.stringify(walked);
      } catch {
        // Fall through to pattern redaction.
      }
    }
    return this.applyPatterns(value);
  }

  private walkUnknown(value: unknown, key: string | undefined, depth: number): unknown {
    if (depth > this.maxDepth) {
      return typeof value === 'string' ? this.applyPatterns(value) : value;
    }
    if (typeof value === 'string') {
      return this.walkString(value, key, depth);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.walkUnknown(item, key, depth + 1));
    }
    if (value !== null && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, nested] of Object.entries(value as Record<string, unknown>)) {
        if (this.isSensitiveKey(k)) {
          this.note('sensitive_key');
          out[k] = '[REDACTED:sensitive_key]';
        } else {
          out[k] = this.walkUnknown(nested, k, depth + 1);
        }
      }
      return out;
    }
    return value;
  }

  private applyPatterns(value: string): string {
    let current = value;
    for (const rule of this.rules) {
      if (!rule.pattern) {
        continue;
      }
      const re = new RegExp(
        rule.pattern.source,
        rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`,
      );
      const replacement = rule.replace ?? `[REDACTED:${rule.name}]`;
      const next = current.replace(re, () => {
        this.note(rule.name);
        return replacement;
      });
      current = next;
    }
    current = current.replace(CC_CANDIDATE, (match) => {
      const digits = match.replace(/\D/g, '');
      if (luhnOk(digits)) {
        this.note('credit_card');
        return '[REDACTED:credit_card]';
      }
      return match;
    });
    return current;
  }

  private note(rule: string): void {
    this.triggered.add(rule);
    this.count += 1;
  }
}

function looksLikeJson(value: string): boolean {
  if (value.length < 2) {
    return false;
  }
  const start = value[0];
  const end = value[value.length - 1];
  return (start === '{' && end === '}') || (start === '[' && end === ']');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function redactTrace(trace: Trace, options?: RedactionOptions): Trace {
  return new Redactor(options).redactTrace(trace);
}
