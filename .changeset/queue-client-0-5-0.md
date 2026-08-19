---
'@workflow/world-vercel': patch
---

Update `@vercel/queue` to 0.5.0, whose dynamic import carries bundler-ignore hints so the queue client can be bundled by Turbopack, webpack, and Vite.
