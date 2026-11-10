---
"@workflow/world-local": patch
---

Stop `@vercel/nft` from copying the build machine's temp directory into functions that bundle the local world, such as the SvelteKit catch-all function.
