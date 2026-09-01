---
'@workflow/core': patch
'@workflow/astro': patch
'@workflow/sveltekit': patch
'@workflow/world': patch
'@workflow/world-postgres': patch
---

Register flow queue handlers at module load with retrying initialization, and construct Astro and SvelteKit entrypoints once so direct-delivery Worlds can start without an HTTP warm-up.
