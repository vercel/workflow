---
'@workflow/next': minor
---

Change `lazyDiscovery` default to `true` for `withWorkflow`. Workflow
discovery is now deferred until files are requested instead of scanning
eagerly at startup on Next.js versions that support deferred entries
(>= 16.2.0-canary.48). Older versions automatically fall back to eager
discovery. Pass `workflows: { lazyDiscovery: false }` to opt back into
eager discovery on supported Next.js versions.
