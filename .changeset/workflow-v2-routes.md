---
"@workflow/astro": patch
"@workflow/builders": patch
"@workflow/cli": patch
"@workflow/core": patch
"@workflow/nest": patch
"@workflow/next": patch
"@workflow/nitro": patch
"@workflow/sveltekit": patch
"@workflow/utils": patch
"@workflow/world-local": patch
"@workflow/world-postgres": patch
"@workflow/world-testing": patch
---

Move the combined workflow execution route to `/v2` while keeping webhooks and the manifest under `/v1`, and clean stale v1 execution artifacts.
