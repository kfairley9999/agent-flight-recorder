# Changelog

All notable changes to this project are documented in this file.

## 0.1.0 — 2026-11-21

First public release.

- TypeScript SDK that records multi-agent runs as an OpenTelemetry-compatible trace (parent/child spans, causal links, message events, model parameters, tool I/O, decisions).
- Best-effort redaction of common secrets and PII before a trace is stored, with documented limits.
- Deterministic replay with recorded stubs, plus hybrid replay that can swap in a live model from a given step.
- Run diffing that ignores IDs and timestamps and reports the first divergence.
- CLI: `inspect`, `view`, `html`, `redact`, `diff`, `replay`, `export-otlp`.
- Local static timeline viewer and a self-contained HTML export.
- Adapters for a plain tool-calling loop and for MCP-shaped in-process tools.
- Example four-agent research desk with a checked-in recorded trace.
- CI for lint, format, typecheck, tests, coverage, and build on Node 22 and 24.
