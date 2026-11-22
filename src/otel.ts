import {
  SDK_NAME,
  SDK_VERSION,
  type AttributeMap,
  type AttributeValue,
  type Span,
  type Trace,
} from './types.js';

/**
 * OpenTelemetry OTLP/JSON ExportTraceServiceRequest subset.
 * See https://opentelemetry.io/docs/specs/otlp/#json-protobuf-encoding
 */
export interface OtlpExport {
  resourceSpans: OtlpResourceSpans[];
}

interface OtlpResourceSpans {
  resource: { attributes: OtlpKeyValue[] };
  scopeSpans: Array<{
    scope: { name: string; version: string };
    spans: OtlpSpan[];
  }>;
}

interface OtlpSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano?: string;
  attributes: OtlpKeyValue[];
  events: Array<{ timeUnixNano: string; name: string; attributes: OtlpKeyValue[] }>;
  links: Array<{ traceId: string; spanId: string; attributes: OtlpKeyValue[] }>;
  status: { code: number; message?: string };
}

interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

interface OtlpAnyValue {
  stringValue?: string;
  intValue?: string;
  doubleValue?: number;
  boolValue?: boolean;
  arrayValue?: { values: OtlpAnyValue[] };
}

const KIND_MAP: Record<string, number> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};

const STATUS_MAP: Record<string, number> = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
};

export function toOtlpJson(trace: Trace): OtlpExport {
  const resourceAttrs = { ...trace.resource.attributes };
  return {
    resourceSpans: [
      {
        resource: { attributes: toKeyValues(resourceAttrs) },
        scopeSpans: [
          {
            scope: { name: SDK_NAME, version: SDK_VERSION },
            spans: trace.spans.map(toOtlpSpan),
          },
        ],
      },
    ],
  };
}

function toOtlpSpan(span: Span): OtlpSpan {
  const otlp: OtlpSpan = {
    traceId: span.traceId,
    spanId: span.spanId,
    name: span.name,
    kind: KIND_MAP[span.kind] ?? 1,
    startTimeUnixNano: span.startTimeUnixNano,
    attributes: toKeyValues(span.attributes),
    events: span.events.map((event) => ({
      timeUnixNano: event.timeUnixNano,
      name: event.name,
      attributes: toKeyValues(event.attributes ?? {}),
    })),
    links: span.links.map((link) => ({
      traceId: link.traceId,
      spanId: link.spanId,
      attributes: toKeyValues(link.attributes ?? {}),
    })),
    status: { code: STATUS_MAP[span.status.code] ?? 0 },
  };
  if (span.parentSpanId !== undefined) {
    otlp.parentSpanId = span.parentSpanId;
  }
  if (span.endTimeUnixNano !== undefined) {
    otlp.endTimeUnixNano = span.endTimeUnixNano;
  }
  if (span.status.message !== undefined) {
    otlp.status.message = span.status.message;
  }
  return otlp;
}

function toKeyValues(attrs: AttributeMap): OtlpKeyValue[] {
  return Object.entries(attrs).map(([key, value]) => ({ key, value: toAnyValue(value) }));
}

function toAnyValue(value: AttributeValue): OtlpAnyValue {
  if (typeof value === 'string') {
    return { stringValue: value };
  }
  if (typeof value === 'boolean') {
    return { boolValue: value };
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value)) {
      return { intValue: String(value) };
    }
    return { doubleValue: value };
  }
  return { arrayValue: { values: value.map(toAnyValue) } };
}

export function otlpSpanCount(exportDoc: OtlpExport): number {
  return exportDoc.resourceSpans.reduce(
    (sum, rs) => sum + rs.scopeSpans.reduce((inner, ss) => inner + ss.spans.length, 0),
    0,
  );
}
