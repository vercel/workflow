---
"@workflow/builders": patch
---

Only rewrite .ts extensions to .js in externalized step imports when targeting Node's native ESM loader (vitest), preserving original extensions for framework bundlers (Next.js, SvelteKit, etc.)
