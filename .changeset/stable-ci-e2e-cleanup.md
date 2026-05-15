---
"@workflow/astro": patch
"@workflow/builders": patch
"@workflow/core": patch
"@workflow/nest": patch
"@workflow/next": patch
"@workflow/sveltekit": patch
"@workflow/utils": patch
"workflow": patch
---

Fix local workflow port detection, make generated health endpoints respond to HEAD requests, materialize manual webhook response bodies before returning them, and stabilize remote Vercel e2e checks around CLI inspection, sleep timing, and hook disposal.
