---
'@workflow/builders': minor
'@workflow/next': minor
---

Add an experimental `workflows.experimentalRoutePrefix` option to `withWorkflow()`, backed by the same field on the Next.js builder config. It emits the generated workflow routes, their queue trigger config and the manifest below a route segment the app owns (`/ship/.well-known/workflow/v1/flow`) and resolves runtime workflow URLs against it, so an app that cannot own the origin's root paths, such as a Microfrontends child app, can host its own workflow routes.
