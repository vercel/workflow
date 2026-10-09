---
"@workflow/core": patch
---

Materialize lazy retained-runner write acknowledgements from already-known
submitted payloads after validating committed identity and position. Preserve
resolved-payload and metadata conflict checks, and identify the failed check in
conflict diagnostics.
