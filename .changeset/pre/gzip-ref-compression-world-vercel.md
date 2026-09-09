---
'@workflow/world-vercel': minor
---

Advertise specVersion 5 so new Vercel runs are eligible for gzip payload compression. The workflow-server declared spec-5 support in vercel/workflow-server#520; payloads remain opaque to the server (compression is client-side). Spec 5 is a superset of spec 4, so initial run attributes still work.
