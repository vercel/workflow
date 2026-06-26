---
'@workflow/core': minor
---

Compress serialized payloads (step inputs/outputs, workflow arguments/return values, errors, hook payloads) before storage using composable codec format prefixes. zstd is the preferred codec (markedly faster than gzip at an equal-or-better ratio, via `node:zlib`); gzip (`CompressionStream`) is the portable fallback when zstd is unavailable. Reads dispatch on the prefix, so both codecs are always decodable. Compression is applied before encryption, gated on run specVersion 5, and skipped for small or incompressible payloads. `WORKFLOW_DISABLE_COMPRESSION=1` disables writes; `WORKFLOW_COMPRESSION_CODEC=gzip` forces the portable codec.
