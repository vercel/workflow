---
"@workflow/rollup": patch
"@workflow/builders": patch
---

Externalize the optional `@opentelemetry/api` peer in the Rollup/Vite framework builds (SvelteKit, Nitro, Nuxt, Astro, Vite) only when it isn't installed, so a build no longer fails with "failed to resolve import '@opentelemetry/api'". When the peer is present it is bundled/resolved as before, so tracing keeps working — including in self-contained outputs like Nitro's `.output/server`.
