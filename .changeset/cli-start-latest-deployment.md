---
"@workflow/cli": patch
"@workflow/world-vercel": patch
---

`workflow start <workflow-name>` resolves its deployment the same way `start()` resolves `deploymentId: 'latest'`, through the World's `resolveLatestDeploymentId()`, instead of reading it from the newest run, so a workflow that has never run can be started. On Vercel this is the newest ready deployment of the project in the `--env` environment. A new `--deployment <id|latest>` flag picks the target explicitly. Outside a deployment, world-vercel's `resolveLatestDeploymentId()` now resolves relative to the configured `projectConfig` project and environment.
