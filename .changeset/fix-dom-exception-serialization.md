---
"@workflow/core": patch
---

Fix `DOMException` serialization. The reducer's first guard was `types.isNativeError(value)`, which returns `false` for `DOMException` in Node — so DOMExceptions never matched and devalue fell through to its arbitrary-POJO failure path. Switch the guard to a constructor-name check (cross-VM safe) so `DOMException` round-trips correctly. This is the type that surfaces as `signal.reason` when `AbortController.abort()` is called with no argument, so the fix is required for serializing aborted signals through step boundaries.
