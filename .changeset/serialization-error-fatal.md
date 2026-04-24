---
"@workflow/core": patch
"@workflow/errors": patch
---

Mark `SerializationError` as `fatal` and route step-return dehydration through the step-handler's user-code failure path. Serialization failures are deterministic — retrying a step that returned a non-POJO will always fail the same way — so these errors now short-circuit the retry loop on attempt 1 instead of burning the full max-deliveries budget.
