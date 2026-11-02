---
"@workflow/builders": minor
"@workflow/next": minor
---

Fail a Next.js production build when the app can start a workflow the build did not register.

Workflow discovery walks the import graph from your Next.js entrypoints and only follows literal string specifiers, so a workflow reached another way — through a computed `import()`, or an import the resolver cannot follow — is compiled into your application without being registered in the generated flow route. `start()` still accepts it, because the `"use workflow"` transform gave it an ID, and every run it creates fails with `WorkflowNotRegisteredError` after the deployment is already live.

Both halves of that are things the compiler already knows. As Next.js compiles, the transform now reports the workflow IDs it stamps into each module; when the build finishes, `withWorkflow()` compares them against the workflows the flow route registered and fails the build on anything the first set has and the second does not, naming the workflow and the module that declared it.

The comparison is built so that it cannot report a workflow the app does not have:

- Both sides come from the compiler's own structured output rather than from pattern-matching build artifacts, so a workflow ID quoted in a comment, a string, or a code-generation template is never mistaken for a reference. Shipped server bundles are not comment-stripped, and the SDK's own documentation quotes example IDs.
- Records are reset before the build compiles, so an entry can only describe a module this build transformed. A bundler serving a module from its loader cache contributes nothing, which costs the check coverage and can never invent a finding.
- An unreadable manifest is skipped rather than read as "registered nothing", which would otherwise report every workflow in the app.
- With `WORKFLOW_DISCOVER_NODE_MODULES` off, the check reports without failing: opting out of dependency discovery deliberately leaves a dependency's workflows unregistered while the bundler still compiles them.

Set `WORKFLOW_REGISTRATION_CHECK=warn` to report without failing, or `off` to skip.

`@workflow/builders` gains the framework-agnostic half of this (`recordWorkflowAppGraphEntry`, `readWorkflowAppGraph`, `resetWorkflowAppGraph`, `findUnregisteredWorkflows`), so integrations beyond Next.js can feed the same check from their own app-code transform.
