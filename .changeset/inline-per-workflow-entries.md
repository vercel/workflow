---
"@workflow/core": patch
"@workflow/builders": patch
"@workflow/next": patch
"workflow": patch
---

Inline delivery with Next.js now loads only the started or resumed workflow's code: the builder writes one inline entry per workflow file (plus one shared copy of the app's serde registrations), and each workflow module registers a lazy import of its own entry for Node.js server code, replacing the alias to the whole flow route. Steps come from the route's own imports; a run whose workflow can call a step that isn't registered in the process is queued to the flow route, as is a QuickJS run, since inline entries leave the QuickJS engine out (`@workflow/core/runtime/flow-entrypoint`, `workflow/internal/inline-runtime`). `WORKFLOW_INLINE_ENTRIES=0` at build time skips the entries.
