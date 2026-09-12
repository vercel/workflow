---
'@workflow/nest': patch
'@workflow/builders': patch
---

Preserve raw request and response bytes on the NestJS workflow routes, serve `GET`/`HEAD`/`OPTIONS` on the flow route, adopt `setGlobalPrefix()` for generated URLs, add `forRootAsync`, and fail startup when `skipBuild` is set without pre-built bundles.
