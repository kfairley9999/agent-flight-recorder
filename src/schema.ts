import { z } from 'zod';
import { SCHEMA_VERSION, type Trace } from './types.js';

const attributeValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.string()),
  z.array(z.number()),
  z.array(z.boolean()),
]);

const attributeMapSchema = z.record(z.string(), attributeValueSchema);

const spanStatusSchema = z.object({
  code: z.enum(['UNSET', 'OK', 'ERROR']),
  message: z.string().optional(),
});

const spanEventSchema = z.object({
  name: z.string(),
  timeUnixNano: z.string().regex(/^\d+$/),
  attributes: attributeMapSchema.optional(),
});

const spanLinkSchema = z.object({
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  spanId: z.string().regex(/^[0-9a-f]{16}$/),
  attributes: attributeMapSchema.optional(),
});

const spanSchema = z.object({
  traceId: z.string().regex(/^[0-9a-f]{32}$/),
  spanId: z.string().regex(/^[0-9a-f]{16}$/),
  parentSpanId: z
    .string()
    .regex(/^[0-9a-f]{16}$/)
    .optional(),
  name: z.string(),
  kind: z.enum(['internal', 'client', 'server', 'producer', 'consumer']),
  startTimeUnixNano: z.string().regex(/^\d+$/),
  endTimeUnixNano: z.string().regex(/^\d+$/).optional(),
  status: spanStatusSchema,
  attributes: attributeMapSchema,
  events: z.array(spanEventSchema),
  links: z.array(spanLinkSchema),
});

export const traceSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  resource: z.object({
    attributes: attributeMapSchema,
  }),
  run: z.object({
    id: z.string().min(1),
    name: z.string(),
    startedAt: z.string(),
    endedAt: z.string().optional(),
    status: z.enum(['UNSET', 'OK', 'ERROR']),
  }),
  spans: z.array(spanSchema),
  redaction: z.object({
    applied: z.boolean(),
    rulesTriggered: z.array(z.string()),
    redactedCount: z.number().int().nonnegative(),
  }),
});

export type ParsedTrace = z.infer<typeof traceSchema>;

export function parseTrace(input: unknown): Trace {
  return traceSchema.parse(input) as Trace;
}

export function safeParseTrace(
  input: unknown,
): { ok: true; trace: Trace } | { ok: false; error: z.ZodError } {
  const result = traceSchema.safeParse(input);
  if (result.success) {
    return { ok: true, trace: result.data as Trace };
  }
  return { ok: false, error: result.error };
}
