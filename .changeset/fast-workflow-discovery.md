---
'@workflow/builders': patch
'@workflow/next': patch
'@workflow/nest': patch
---

Optimize eager workflow discovery and improve default eager build compatibility. Also fixes NestJS builds pulling SDK build-tooling into the runtime steps bundle, which crashed step handlers at runtime.
