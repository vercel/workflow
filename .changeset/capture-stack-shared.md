---
"@workflow/core": patch
---

Extract the `Error.captureStackTrace` fallback into a shared `redirectStackToCaller` helper used by both context-violation errors and `getWorkflowMetadata()`, so the V8-feature-detect logic only lives in one place.
