---
"@workflow/builders": patch
---

Treat a package `exports` object whose keys are all conditions (such as `{ "types": "./src/index.ts", "default": "./src/index.ts" }`) as the root export when resolving module specifiers and import paths. The condition name used to be read as a subpath, so a workflow in such a package got an ID like `@internal/agentypes@1.0.0` and the workflow bundle failed with `Could not resolve "@internal/agentypes"`.
