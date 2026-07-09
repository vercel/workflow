---
"@workflow/rollup": patch
"@workflow/builders": patch
---

Externalize the optional `@opentelemetry/api` peer in the Rollup/Vite framework builds (SvelteKit, Nitro, Nuxt, Astro, Vite) so a build no longer fails with "failed to resolve import '@opentelemetry/api'" when the peer isn't installed. Tracing still loads the real OpenTelemetry API at runtime when the peer is present.
