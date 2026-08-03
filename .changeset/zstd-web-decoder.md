---
'@workflow/web-shared': minor
---

Decode zstd-compressed workflow payloads in the observability UI. Since the Web `DecompressionStream` has no zstd support, the web o11y registers a WASM-backed zstd decoder (`@tootallnate/zstd-wasm`) with `@workflow/core` before hydrating payloads; the WASM is compiled lazily on first use.
