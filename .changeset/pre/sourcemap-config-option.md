---
"@workflow/builders": minor
"@workflow/nitro": minor
"@workflow/nest": minor
"@workflow/next": minor
"@workflow/sveltekit": minor
"@workflow/astro": minor
---

Add `sourcemap` option to builders for disabling or customising source map emission on generated workflow bundles. Accepts the same values as esbuild's `sourcemap` option: `true`, `false`, `'inline'`, `'linked'`, `'external'`, `'both'`. Can also be set via the `WORKFLOW_SOURCEMAP` environment variable.

Setting `sourcemap: false` drops inline source maps from the step, workflow and webhook bundles, and skips the source-map-support runtime shim on the Vercel step function — helpful for staying under the Vercel 250MB function size limit.

Exposed per framework: `nitro.options.workflow.sourcemap`, `NestBuilderOptions.sourcemap`, `withWorkflow({ workflows: { sourcemap } })`, and the `sourcemap` option on `workflowPlugin()` for SvelteKit and Astro.

Minor semantics change: when the `sourcemap` option (or `WORKFLOW_SOURCEMAP`) is set explicitly, it now applies to **all** generated bundles. Previously, the final workflow wrapper and webhook bundles could only be toggled via the legacy `WORKFLOW_EMIT_SOURCEMAPS_FOR_DEBUGGING=1` env var, which continues to work but is narrower in scope.
