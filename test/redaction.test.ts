import { describe, expect, it } from 'vitest';
import { luhnOk, Redactor, redactTrace } from '../src/redaction.js';
import { SCHEMA_VERSION, type Trace } from '../src/types.js';

const SAMPLE_PAN = '4111111111111111';

function emptyTrace(): Trace {
  return {
    schemaVersion: SCHEMA_VERSION,
    resource: { attributes: { 'service.name': 't' } },
    run: { id: 'a'.repeat(32), name: 'n', startedAt: '2026-01-01T00:00:00.000Z', status: 'OK' },
    spans: [
      {
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        name: 'llm:demo',
        kind: 'client',
        startTimeUnixNano: '1',
        status: { code: 'OK' },
        attributes: {},
        events: [],
        links: [],
      },
    ],
    redaction: { applied: false, rulesTriggered: [], redactedCount: 0 },
  };
}

function firstSpan(trace: Trace) {
  const span = trace.spans[0];
  if (!span) {
    throw new Error('expected a span');
  }
  return span;
}

describe('luhn', () => {
  it('accepts a well-known Visa test number and rejects a mutated one', () => {
    expect(luhnOk(SAMPLE_PAN)).toBe(true);
    expect(luhnOk('4111111111111112')).toBe(false);
    expect(luhnOk('123')).toBe(false);
  });
});

describe('Redactor', () => {
  it('redacts api keys, emails, phones, ssns, jwts, and pem blocks', () => {
    const redactor = new Redactor();
    const input =
      'key sk-abcdefghijklmnopqrstuvwxyz012345 contact jane.doe@example.com at 415-555-0198 ssn 078-05-1120 token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.8E2b3zq0n4y1kQm0J5p0lQ6y3k0dummyxx ' +
      '-----BEGIN RSA PRIVATE KEY-----\nMIIBOgIBAAJBAK8=\n-----END RSA PRIVATE KEY-----';
    const out = redactor.redactString(input);
    expect(out).toContain('[REDACTED:openai_key]');
    expect(out).toContain('[REDACTED:email]');
    expect(out).toContain('[REDACTED:phone]');
    expect(out).toContain('[REDACTED:ssn]');
    expect(out).toContain('[REDACTED:jwt]');
    expect(out).toContain('[REDACTED:pem_private_key]');
    expect(out).not.toContain('jane.doe@example.com');
    expect(out).not.toContain('sk-abcdefghijklmnopqrstuvwxyz012345');
  });

  it('redacts anthropic, groq, github, slack, aws, and bearer tokens', () => {
    const out = new Redactor().redactString(
      'sk-ant-abcdefghijklmnopqrstuvwxyz Bearer abcdefghijklmnopqrs gsk_abcdefghijklmnopqrst AKIAIOSFODNN7EXAMPLE ghp_abcdefghijklmnopqrstuv w xyz github_pat_abcdefghijklmnopqrst xoxb-1234567890-abcdefghij',
    );
    expect(out).toContain('[REDACTED:anthropic_key]');
    expect(out).toContain('[REDACTED:bearer_token]');
    expect(out).toContain('[REDACTED:groq_key]');
    expect(out).toContain('[REDACTED:aws_access_key]');
    expect(out).toContain('[REDACTED:github_token]');
    expect(out).toContain('[REDACTED:github_pat]');
    expect(out).toContain('[REDACTED:slack_token]');
  });

  it('redacts Luhn-valid card numbers but leaves nearby non-cards alone', () => {
    const out = new Redactor().redactString(`invoice ${SAMPLE_PAN} and ref 1234-5678-9012`);
    expect(out).toContain('[REDACTED:credit_card]');
    expect(out).toContain('1234-5678-9012');
  });

  it('redacts values of sensitive keys, including nested JSON strings', () => {
    const out = new Redactor().redactString(
      JSON.stringify({
        api_key: 'not-even-a-pattern',
        nested: { password: 'hunter2', ok: 'visible' },
      }),
    );
    const parsed = JSON.parse(out) as { api_key: string; nested: { password: string; ok: string } };
    expect(parsed.api_key).toBe('[REDACTED:sensitive_key]');
    expect(parsed.nested.password).toBe('[REDACTED:sensitive_key]');
    expect(parsed.nested.ok).toBe('visible');
  });

  it('applies custom patterns and keys', () => {
    const redactor = new Redactor({
      extraPatterns: [{ name: 'project_code', pattern: /\bPF-\d{4}\b/g }],
      extraSensitiveKeys: ['badgeId'],
    });
    expect(redactor.redactString('code PF-2048')).toContain('[REDACTED:project_code]');
    const nested = redactor.redactString(JSON.stringify({ badgeId: '99', other: 'ok' }));
    expect(JSON.parse(nested).badgeId).toBe('[REDACTED:sensitive_key]');
  });

  it('can be disabled and reports counts on a full trace', () => {
    const trace = emptyTrace();
    firstSpan(trace).attributes['afr.message.content'] = 'hello sk-abcdefghijklmnopqrstuvwxyzjane';
    firstSpan(trace).events.push({
      name: 'afr.message',
      timeUnixNano: '1',
      attributes: { 'afr.message.content': 'mail me@example.com' },
    });
    const disabled = redactTrace(trace, { enabled: false });
    expect(disabled.redaction.applied).toBe(false);
    expect(firstSpan(disabled).attributes['afr.message.content']).toContain('sk-');

    const enabled = redactTrace(trace);
    expect(enabled.redaction.applied).toBe(true);
    expect(enabled.redaction.redactedCount).toBeGreaterThan(0);
    expect(enabled.redaction.rulesTriggered.length).toBeGreaterThan(0);
  });

  it('redacts authorization attributes by key name even when the value is an array', () => {
    const trace = emptyTrace();
    firstSpan(trace).attributes['authorization'] = ['secret-a', 'secret-b'];
    const out = new Redactor().redactTrace(trace);
    expect(firstSpan(out).attributes['authorization']).toEqual([
      '[REDACTED:sensitive_key]',
      '[REDACTED:sensitive_key]',
    ]);
  });
});
