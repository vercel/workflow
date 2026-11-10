---
'@workflow/cli': patch
'@workflow/core': patch
---

Support Next.js' `workflows.experimentalRoutePrefix` in local tooling: `workflow health` takes `--base-path`, the CLI and web UI find a manifest generated below a route prefix, and the flow route span's `http.route` includes the base path.
