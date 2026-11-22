import { randomBytes } from 'node:crypto';

/** 16-byte OpenTelemetry trace ID as 32 lowercase hex characters. */
export function newTraceId(): string {
  return randomBytes(16).toString('hex');
}

/** 8-byte OpenTelemetry span ID as 16 lowercase hex characters. */
export function newSpanId(): string {
  return randomBytes(8).toString('hex');
}

const HEX_16 = /^[0-9a-f]{16}$/;
const HEX_32 = /^[0-9a-f]{32}$/;

export function isSpanId(value: string): boolean {
  return HEX_16.test(value);
}

export function isTraceId(value: string): boolean {
  return HEX_32.test(value);
}
