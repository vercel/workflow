---
'@workflow/next': minor
'@workflow/nitro': minor
'@workflow/nuxt': minor
'@workflow/astro': minor
'@workflow/sveltekit': minor
'@workflow/nest': minor
---

Forward the completed-bundle hook through the framework integrations so
applications can generate derived workflow metadata consistently. Relative
workflow output paths are resolved against the builder's `workingDir` so the
paths reported to the hook match the files written to disk.
