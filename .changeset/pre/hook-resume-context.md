---
"@workflow/world": patch
"@workflow/world-postgres": patch
"@workflow/core": patch
"@workflow/web-shared": patch
---

Hooks can carry an optional `resumeContext`; when present, `resumeHook`/`resumeWebhook` resume from it directly instead of fetching the full run, saving a round trip per resume. When the context also carries the run's `encryptionPublicKey`, the resume seals its payload (`encp`) directly to that key, so a default webhook resume needs neither a run read nor a run-key lookup. These two optimizations fall back independently: it fetches the full run when the context is absent, and uses symmetric encryption when no usable public key is available.
