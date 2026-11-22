# Design

This document describes the v0.1 trace format, how spans relate to OpenTelemetry, and the semantics of replay and run diffing.

## Goals

1. Record a _multi-agent_ run as one trace, not a pile of unrelated LLM logs.
2. Keep the format close enough to OpenTelemetry that a trace can be exported as OTLP/JSON and inspected in familiar terms (trace ID, span ID, parent, links, events, status, Unix-nano time).
3. Make replay and diff possible without re-implementing an agent framework.
4. Redact secrets and PII before anything is written to disk.

Non-goals for v0.1: a hosted collector, a drop-in official OpenTelemetry SDK, automatic instrumentation of third-party frameworks, or guaranteed concealment of every secret.

## Trace document

A stored run is a JSON document with schema version `0.1.0`:

```json
{
  "schemaVersion": "0.1.0",
  "resource": { "attributes": { "service.name": "research-desk" } },
  "run": {
    "id": "<32-hex trace id>",
    "name": "weekly-brief",
    "startedAt": "…",
    "endedAt": "…",
    "status": "OK"
  },
  "spans": [],
  "redaction": { "applied": true, "rulesTriggered": ["email"], "redactedCount": 1 }
}
```

The `run.id` is the OpenTelemetry trace ID. Spans use 16-hex span IDs, optional `parentSpanId`, `startTimeUnixNano` / `endTimeUnixNano` as decimal strings, `kind`, `status`, `attributes`, `events`, and `links`.

Attribute values are OTel primitives: string, number, boolean, or homogeneous arrays of those. Structured tool arguments and results are stored as canonical JSON strings so they can be redacted and hashed.

## Semantic conventions

| Attribute                                             | Meaning                                                                |
| ----------------------------------------------------- | ---------------------------------------------------------------------- |
| `afr.span.type`                                       | `run` \| `agent` \| `llm` \| `tool` \| `decision` \| `handoff`         |
| `afr.step.index`                                      | Monotonic integer in start order, used by replay                       |
| `afr.agent.id` / `afr.agent.role`                     | Identity of the agent that owns the span                               |
| `afr.tool.name` / `afr.tool.call_id`                  | Tool identity                                                          |
| `afr.tool.arguments` / `afr.tool.result`              | Canonical JSON (redacted)                                              |
| `afr.decision.type` / `afr.decision.summary`          | An explicit choice                                                     |
| `afr.link.type`                                       | `handoff` \| `uses_result` \| `caused_by` \| `follows` \| `parent_run` |
| `gen_ai.system`                                       | Provider, when known                                                   |
| `gen_ai.request.model`                                | Model name                                                             |
| `gen_ai.request.temperature` / `max_tokens` / `top_p` | Request parameters                                                     |
| `gen_ai.response.output` / `finish_reason`            | Model output                                                           |
| `gen_ai.usage.input_tokens` / `output_tokens`         | Usage, when the caller supplies it                                     |

Messages are events named `afr.message` with `afr.message.role` and `afr.message.content`. Tool results also appear as `afr.tool.result` events. Exceptions use the OTel `exception` event name.

Causal relationships that are _not_ parent/child (for example, a writer that consumes a researcher's notes) are recorded as span links rather than forcing an awkward hierarchy.

## Recording

`FlightRecorder.startRun` opens a root `run` span and a `RunSession`. Agents, LLM calls, and tool calls are child spans. `AsyncLocalStorage` is available via `run.withAgent` so nested helpers can inherit the current agent without threading handles through every call.

`flush(run)`:

1. Ends the run and any still-open child spans.
2. Snapshots the spans.
3. Runs the redactor (unless `redactOnFlush` is false).
4. Writes the redacted document to the `TraceStore`.
5. Drops the in-memory span buffers for that run.

The default store is in memory. `FileTraceStore` writes `<runId>.afr.json`.

## Replay

Two APIs share the same stub tables, built from the recorded `llm` and `tool` spans in step order.

### Harness (`complete` / `callTool`)

Application code drives the same control flow again. `complete({ model })` and `callTool(name, args)` return the next recorded output, or raise `ReplayDivergenceError` if the name or model does not match the next recorded step.

- **deterministic** (default): every step returns the recorded output.
- **hybrid**: steps with `afr.step.index < fromStep` always use stubs; later LLM calls go to a caller-supplied `liveModel`. Tools remain stubbed so a model change can be compared against a frozen world.

`fromStep` is inclusive: the named step is the first one that may go live.

### `resimulate()`

Walks the recorded span sequence and emits a new trace, without application code. Useful for export tests and for applying a hybrid model swap to an existing recording.

Replay cannot restore hidden process state that never passed through the recorder (caches, wall-clock branches, unrecorded I/O).

## Diff

`diffRuns(left, right)` compares traces after dropping IDs and timestamps.

1. Filter out the root `run` span.
2. Sort remaining spans by `afr.step.index`.
3. Align them with LCS on a signature: `type|agentId|name|tool|model|decision`.
4. For aligned pairs, compare status, messages, tool arguments and results, LLM outputs, decision summaries, and other non-volatile attributes.

The first difference is `firstDivergence`. Equivalent recordings of the same control flow should compare equal even when they were recorded in different processes with different IDs.

## OTLP export

`toOtlpJson(trace)` produces an `ExportTraceServiceRequest`-shaped JSON document (`resourceSpans` → `scopeSpans` → `spans`). Span kinds and status codes use the OTLP protobuf numeric enums. This is a one-way export in v0.1; there is no OTLP importer and no gRPC exporter.

## Adapters

The core SDK is framework-agnostic. v0.1 ships:

- A plain tool-calling loop (`runToolLoop`) that records each model turn and each tool result, including unknown-tool and thrown-handler errors.
- An MCP-shaped wrapper (`instrumentMcpTools`) for in-process `{ name, arguments }` tools. It is not itself an MCP server.

A scripted four-agent desk in `examples/research-desk.ts` exercises both, plus handoff links and a revision cycle.

## Versioning

The JSON `schemaVersion` and the package version start at `0.1.0`. Additive attribute changes should keep the same schema version; breaking changes to required fields will bump `schemaVersion`.
