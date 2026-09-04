---
'@workflow/builders': patch
'@workflow/core': patch
'@workflow/nest': patch
'@workflow/next': patch
'@workflow/nitro': patch
'@workflow/nuxt': patch
'@workflow/astro': patch
'@workflow/rollup': patch
'@workflow/sveltekit': patch
'@workflow/utils': patch
'@workflow/cli': patch
'@workflow/world-testing': patch
'@workflow/world-local': patch
'@workflow/world-vercel': patch
'workflow': patch
---

Revert the static workflow world target injection: the world package is again resolved at runtime from `WORKFLOW_TARGET_WORLD` instead of being aliased into host bundles at build time.
