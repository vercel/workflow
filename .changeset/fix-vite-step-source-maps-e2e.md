---
---

Fix vite local-dev e2e error tests by enabling step source-map assertions for vite. After bumping vite to ^7.3.2 (#1827), vite preserves step bundle source maps in dev mode and stack traces now contain original file paths (`99_e2e.ts`, `helpers.ts`), so `hasStepSourceMaps()` should return `true` for vite local dev.
