---
---

Enable Vercel-prod e2e tests for the tanstack-start workbench now that the
Vercel project is connected, and pin its `react`/`@types/react` versions to
match `nextjs-turbopack` so pnpm dedupes them across the workspace (the
mismatch was breaking the nextjs-turbopack and nextjs-webpack production
builds with a `MotionStyle` type error coming from two `@types/react`
copies).
