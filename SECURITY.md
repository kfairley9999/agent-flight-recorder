# Security

Agent Flight Recorder is a local library that stores traces of agent runs. Those traces can contain prompts, tool arguments, tool results, and model outputs — which often contain secrets or personal data. This document states what the redactor does, what it does not do, and how to use the recorder without making things worse.

## Reporting

If you find a security issue in this repository, please open a [GitHub advisory](https://github.com/kfairley9999/agent-flight-recorder/security/advisories/new) or email the maintainer through the address on [github.com/kfairley9999](https://github.com/kfairley9999). Do not file a public issue with a live secret in it.

## What is stored

By default, `FlightRecorder.flush()` redacts a run and then writes the redacted document to the configured store. The in-memory span buffers for that run are dropped afterwards.

Until `flush()` is called, **unredacted** data lives in process memory. A crash dump, a debugger, or a custom `TraceStore` that skips the recorder can capture it. If you set `redactOnFlush: false`, the store receives the raw snapshot.

The local HTTP viewer binds to `127.0.0.1` by default and serves a single trace. It is not authenticated. Do not expose it on a public interface.

## Redaction guarantees

The redactor is a deterministic, best-effort filter. After a successful `flush()` with redaction enabled:

1. Every string attribute and event attribute is scanned with the built-in (and any extra) patterns.
2. Values of well-known sensitive keys (`authorization`, `api_key`, `password`, `token`, `cookie`, `private_key`, `aws_secret_access_key`, and similar) are replaced even when the value does not match a known secret shape.
3. String values that are themselves JSON are parsed and walked up to a depth limit (default 6), then re-serialized.
4. The stored document's `redaction` object reports whether redaction ran, which rule names fired, and how many replacements were made.

Replacement text looks like `[REDACTED:email]` so a reviewer can see _that_ something was removed without seeing the original.

Built-in patterns cover common API keys (including OpenAI-style, Anthropic, Groq, GitHub, Slack, and AWS access key IDs), `Bearer` tokens, JWTs, PEM private key blocks, email addresses, US phone numbers, US Social Security numbers in the `AAA-GG-SSSS` form, and Luhn-valid payment-card numbers.

## Limits — please read these

Redaction is **not** a guarantee that a stored trace is free of secrets or personal data. In particular:

- **Unknown or novel secret formats** are not detected. A custom token that does not match a built-in or caller-supplied pattern will be stored as-is unless its key name is treated as sensitive.
- **Encoding and chunking defeat string patterns.** Base64, hex, gzip, UTF-16, or a secret split across two attributes can pass through. The walker only parses a string when it looks like a single JSON object or array.
- **Partial secrets** (truncated keys, keys with unexpected prefixes, keys inside images, PDFs, or other binary blobs) are not scanned.
- **Phone and SSN patterns are US-centric** and can both miss international formats and, rarely, flag other hyphenated numbers. Card detection uses the Luhn check to reduce false positives; it can still flag test numbers, and it will miss cards that fail Luhn because of prior typoes.
- **Key-name matching is only as good as the name.** `api_key` is redacted; `theThingWeUseToAuth` is not, unless you add it to `extraSensitiveKeys`.
- **Depth and size.** JSON walking stops at `maxDepth`. Very large strings are still pattern-scanned, but pathological inputs may be expensive.
- **No claim of regulatory compliance.** This is not a HIPAA, PCI, GDPR, or SOC 2 control. Do not treat a green redaction report as a legal or audit certification.
- **Diff and export operate on whatever is in the document.** If you diff or export a trace that was stored without redaction, those outputs can contain the original secrets. `afr redact` can be applied after the fact, but anything already copied elsewhere is out of scope.
- **The demo trace is synthetic.** It includes fictional contact details so the redactor can be demonstrated. It does not contain real credentials.

## Recommended usage

- Leave `redactOnFlush` enabled in any process that writes to disk or to a shared store.
- Add `extraPatterns` and `extraSensitiveKeys` for the secret shapes your agents actually see.
- Prefer not to send raw credentials into an agent in the first place; pass handles or allowlisted tool sessions instead.
- Treat stored traces as sensitive documents even after redaction. Restrict filesystem permissions on the store directory.
- Do not commit traces from production runs. The checked-in example is a scripted demo.

## Dependencies and supply chain

This package is intentionally small (runtime dependency: `zod`). It is not published to npm in v0.1; install from source. Review the lockfile when you upgrade.
