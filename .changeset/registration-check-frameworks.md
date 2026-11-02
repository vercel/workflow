---
"@workflow/builders": minor
"@workflow/rollup": patch
"@workflow/nitro": patch
"@workflow/astro": patch
---

Run the workflow registration check on every Rollup-based integration, not just Next.js.

Nitro, Nuxt, Vite, Astro and SvelteKit — and the Hono, Express, Fastify and TanStack Start setups that build through Nitro — now compare the workflows their app compiles against the workflows their build registered, and fail the build on anything in the first set and not the second. The shared half of the check lives in `@workflow/builders`; `@workflow/rollup` records what the transform stamped into each module, and each integration runs the comparison once its own build has finished.

NestJS and the standalone `workflow build` CLI stay uncovered, and the docs now say so: Nest compiles through its own SWC pipeline configured by a generated `.swcrc`, and a hand-wired integration supplies its own transform, so in neither case is Workflow in the loop that would report what it stamped in.

**Fixes a workflow-ID mismatch in `@workflow/rollup`.** A workflow reached through a symlink — a shared `workflows/` directory linked into an app — resolves to its real path outside the app, and the transform named it by wherever it really lives while the builder, globbing it through the link, named it by the app. The two then disagreed about the workflow's ID and `start()` enqueued one the registry had never heard of. `@workflow/next` and the esbuild transform already resolved the alias back; this one stripped the `../` segments instead. On the workbench apps that symlink their workflows, not one of the 134 IDs the transform produced matched the 174 the build registered; now every one does. Only layouts that were already broken this way change behaviour.
