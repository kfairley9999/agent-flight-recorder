import { describe, expect, it } from 'vitest';
import { isSpanId, isTraceId, newSpanId, newTraceId } from '../src/ids.js';
import { createClock, nanoString, nanosToIso, parseNanoString } from '../src/time.js';
import { fnv1aHex, stableStringify, toAttributeValue } from '../src/serialize.js';

describe('ids', () => {
  it('generates unique otel-shaped ids', () => {
    const traces = new Set(Array.from({ length: 50 }, () => newTraceId()));
    const spans = new Set(Array.from({ length: 50 }, () => newSpanId()));
    expect(traces.size).toBe(50);
    expect(spans.size).toBe(50);
    for (const id of traces) {
      expect(isTraceId(id)).toBe(true);
    }
    for (const id of spans) {
      expect(isSpanId(id)).toBe(true);
    }
  });

  it('rejects malformed ids', () => {
    expect(isTraceId('abc')).toBe(false);
    expect(isSpanId('ZZZZZZZZZZZZZZZZ')).toBe(false);
    expect(isTraceId('A'.repeat(32).toLowerCase())).toBe(true);
  });
});

describe('time', () => {
  it('is monotonic', () => {
    const clock = createClock();
    const a = clock();
    const b = clock();
    expect(b >= a).toBe(true);
  });

  it('round-trips nano strings and emits ISO', () => {
    const value = 1700000000000000000n;
    expect(parseNanoString(nanoString(value))).toBe(value);
    expect(nanosToIso(value).endsWith('Z')).toBe(true);
    expect(() => parseNanoString('not-a-number')).toThrow(/Invalid Unix-nano/);
    expect(() => nanosToIso(-1n)).not.toThrow();
  });
});

describe('serialize', () => {
  it('sorts object keys for stable fingerprints', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(fnv1aHex('hello')).toBe(fnv1aHex('hello'));
    expect(fnv1aHex('hello')).not.toBe(fnv1aHex('world'));
  });

  it('coerces unknown values into attribute primitives', () => {
    expect(toAttributeValue('x')).toBe('x');
    expect(toAttributeValue(3)).toBe(3);
    expect(toAttributeValue(true)).toBe(true);
    expect(toAttributeValue(['a', 'b'])).toEqual(['a', 'b']);
    expect(toAttributeValue([1, 2])).toEqual([1, 2]);
    expect(toAttributeValue([true, false])).toEqual([true, false]);
    expect(toAttributeValue({ q: 'search' })).toBe('{"q":"search"}');
  });
});
