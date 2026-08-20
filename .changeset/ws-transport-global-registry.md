---
'@workflow/world-vercel': patch
---

Hold the WebSocket events transport's channel registry on `globalThis` instead of at module scope, so an app that ends up with two copies of the bundled world in one process (for example a Next.js app whose `instrumentation.ts` warms the world) still resolves the channel its queue consumer opened instead of silently writing every event over HTTP.
