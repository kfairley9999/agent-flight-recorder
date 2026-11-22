/** Nanosecond clock aligned to wall time, monotonic within a process. */
export function createClock(nowMs: () => number = Date.now): () => bigint {
  const originMs = nowMs();
  const originHr = process.hrtime.bigint();
  return () => BigInt(originMs) * 1_000_000n + (process.hrtime.bigint() - originHr);
}

/** Convert a Unix-nano timestamp to an ISO-8601 string (millisecond precision). */
export function nanosToIso(nanos: bigint): string {
  const msTotal = nanos / 1_000_000n;
  const date = new Date(Number(msTotal));
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid nanosecond timestamp: ${nanos.toString()}`);
  }
  return date.toISOString();
}

export function nanoString(nanos: bigint): string {
  return nanos.toString();
}

export function parseNanoString(value: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new RangeError(`Invalid Unix-nano string: ${value}`);
  }
  return BigInt(value);
}
