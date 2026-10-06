---
"@workflow/core": patch
---

Mint the compute instance id on first use instead of at module load, so the runtime can be loaded where random values are forbidden in global scope (Cloudflare Workers).
