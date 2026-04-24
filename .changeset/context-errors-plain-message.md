---
"@workflow/core": patch
---

Context-violation errors now store plain text on `.message` / `.stack` and render the ANSI-framed form lazily via `[util.inspect.custom]` / `toString()`. Structured logs, log drains, and CBOR-serialized event payloads no longer contain raw `\x1B[...m` escape bytes.
