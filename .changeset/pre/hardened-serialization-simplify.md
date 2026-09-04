---
'@workflow/core': patch
'workflow': patch
---

Simplify hardened serialization: intrinsic captures assert at import instead of degrading per use, `URLSearchParams` now serializes natively on Node 18, and bound-function getters are reported as guest code (previously a getter defined via `fn.bind()` executed with an empty report).
