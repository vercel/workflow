# Bundle size

[[.github/workflows/bundle-size.yml|`.github/workflows/bundle-size.yml`]] builds the `nextjs-turbopack` and `hono` workbench apps on every PR, measures the `/.well-known/workflow/v1/flow` route, and posts a sticky comment with the delta against `main`.

Pushes to `main` exist to produce the baseline artifacts that PR runs download.

It reports two numbers per app, because neither app emits an isolable function bundle for that route (Next.js emits a ~1 KB turbopack chunk loader pointing at chunks shared with other routes; nitro inlines the handler into a single server entry):

- **Gated**: what the workflow builders emit for the flow route, before the framework bundles it. Growth beyond `max(2%, 50 KiB)` raw fails the job. Add the `allow-bundle-size-growth` label to accept it.
- **Informational**: the framework's own build output. Unrelated changes move it, so it never gates.

The comment is a single table showing **gzip** sizes with the change against `main` in parentheses, because that is the number worth reading at a glance. Everything else, including what gates the job, sits in a collapsed block below it. The gate compares **raw** bytes, which is what the runtime parses on a cold start, so a red check can sit next to a small gzip delta; the collapsed block says so.

The two are only ever compared against their own baselines, never against each other, and neither alone is the deployed function: the gated bundle is the VM code the route carries as an inline string, while the code hosting it sits in the framework output.

**The gate does not cover the world adapters.** Building `nextjs-turbopack` with `WORKFLOW_TARGET_WORLD=local` and `=vercel` produces byte-identical reports on all three metrics, because every world the app depends on is bundled into the framework output either way and the choice is made at runtime. A change confined to `@workflow/world-vercel` will not move the gated numbers.

The job pins `WORKFLOW_SOURCEMAP`, `WORKFLOW_PUBLIC_MANIFEST`, and `WORKFLOW_TARGET_WORLD`, and records them in each report's fingerprint; the renderer refuses to diff reports whose fingerprints disagree. `WORKFLOW_SOURCEMAP=false` is the one that moves the numbers, since sourcemap mode defaults to inline outside a production build and that alone takes the Next flow bundle from 1.38 MB to 5.85 MB. Changing any pin invalidates comparisons against older baselines.
