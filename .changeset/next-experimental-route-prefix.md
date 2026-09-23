---
'@workflow/next': minor
---

Add an experimental `workflows.experimentalRoutePrefix` option to `withWorkflow()`, which emits the generated workflow routes, their Vercel queue trigger config and the manifest under a route segment the app owns (for example `/ship/.well-known/workflow/v1/flow`) and resolves runtime workflow URLs against it. This lets an app that cannot own the origin's root paths, such as a Microfrontends child app, host its own workflow routes.
