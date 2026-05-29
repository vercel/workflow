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

Move workflow execution and canonical webhook routes to `/v2`, while retaining the `/v1/webhook` compatibility endpoint and cleaning stale v1 execution artifacts.
