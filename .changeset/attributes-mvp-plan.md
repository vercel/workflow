---
'@workflow/core': patch
'@workflow/world': patch
'@workflow/world-local': patch
'@workflow/world-postgres': patch
'@workflow/world-vercel': patch
'workflow': patch
---

Add experimental `setAttributes()` for attaching plaintext string key/value metadata to a workflow run from workflow or step code. See the V5 `attributes-mvp` changelog entry for the design, trade-offs, and migration path to the full 5.0.0 attributes feature.
