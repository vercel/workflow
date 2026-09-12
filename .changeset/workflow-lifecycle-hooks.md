---
'@workflow/core': minor
'workflow': minor
---

Add `registerLifecycleHooks` from `workflow/api` for best-effort completion and failure reporting with a read-free workflow name, lazy `Run` instance, and failure cause hydrated from the persisted payload. Run metadata getters avoid resolving input/output payloads.
