---
"@workflow/next": minor
---

Fail a Next.js production build when the app can start a workflow the build did not register.

Workflow discovery walks the import graph from your Next.js entrypoints and only follows plain string specifiers, so a workflow reached another way — through a computed `import()`, or through an import the resolver cannot follow — is compiled into your application without being registered in the generated flow route. `start()` still accepts it, because the `"use workflow"` transform gave it an ID, and every run it creates fails with `WorkflowNotRegisteredError` after the deployment is already live.

After `next build` compiles, `withWorkflow()` now compares the workflow IDs stamped into the server output against the workflows the flow route registered. Both sets come from the same compiler pass, so anything in the first and not the second is a run that is guaranteed to fail, and the build fails instead — naming each workflow and the output files that reference it. Output written before the build started is ignored, so a chunk left behind by an earlier build cannot fail the current one.

Set `WORKFLOW_REGISTRATION_CHECK=warn` to report the same findings without failing, or `off` to skip the check.
