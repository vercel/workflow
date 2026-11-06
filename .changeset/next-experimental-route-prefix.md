---
'@workflow/builders': minor
'@workflow/next': minor
---

Add `workflows.experimentalRoutePrefix` option to `withWorkflow()`, backed by the same field on the Next.js builder config. It emits the generated workflow routes, their queue trigger config and the manifest below a route segment the app owns (e.g. `/dashboard/.well-known/workflow/v1/flow`). Can be used to host workflow routes within a Microfrontends child app
