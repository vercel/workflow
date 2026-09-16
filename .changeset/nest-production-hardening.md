---
'@workflow/nest': minor
---

Preserve raw request and response bytes on the workflow routes, serve `GET`/`HEAD`/`OPTIONS` on the flow route, adopt `setGlobalPrefix()` for generated URLs, add `forRootAsync`, `basePath`, `manageWorldLifecycle` and `preloadBundles`, and fail startup when `skipBuild` is set without pre-built bundles.
