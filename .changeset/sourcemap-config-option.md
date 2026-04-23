---
"@workflow/builders": minor
"@workflow/nitro": minor
"@workflow/nest": minor
"@workflow/next": minor
"@workflow/sveltekit": minor
"@workflow/astro": minor
---

Add `sourcemap` option (`boolean | 'inline' | 'disabled'`) to disable inline source maps in workflow bundles. Defaults unchanged. Exposed per framework: `nitro.options.workflow.sourcemap`, `NestBuilderOptions.sourcemap`, `withWorkflow({ workflows: { sourcemap } })`, and the `sourcemap` option on `workflowPlugin()` for SvelteKit/Astro.
