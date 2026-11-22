import type { AttributeValue } from './types.js';

/** Canonical JSON used for argument fingerprints and stable diffs. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  const out: Record<string, unknown> = {};
  for (const [key, nested] of entries) {
    out[key] = sortValue(nested);
  }
  return out;
}

export function toAttributeValue(value: unknown): AttributeValue {
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item === 'string')) {
      return value;
    }
    if (value.every((item) => typeof item === 'number')) {
      return value;
    }
    if (value.every((item) => typeof item === 'boolean')) {
      return value;
    }
  }
  return stableStringify(value);
}

export function fnv1aHex(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** Copy only defined fields so object literals satisfy exactOptionalPropertyTypes. */
export function assigned<T extends Record<string, unknown>>(obj: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out as T;
}
