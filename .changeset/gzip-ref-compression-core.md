---
'@workflow/core': minor
---

Gzip-compress serialized payloads (step inputs/outputs, workflow arguments/return values, errors, hook payloads) before storage using a new composable `gzip` format prefix. Compression is applied before encryption, gated on run specVersion 5, and skipped for small or incompressible payloads. Set `WORKFLOW_DISABLE_COMPRESSION=1` to opt out of writes; reads always handle both formats.
