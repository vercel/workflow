---
'@workflow/core': patch
---

Fix the payload-compression capability cutoff: gzip/zstd are gated on `5.0.0-beta.18` (the first published version containing the compression read path) instead of `5.0.0-beta.16`. The previous cutoff would let a producer write compressed payloads to a beta.16/beta.17 target that cannot decode them.
