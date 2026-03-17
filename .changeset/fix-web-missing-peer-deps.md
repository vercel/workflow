---
"@workflow/web": patch
---

Add custom `entry.server.tsx` and move `@react-router/node`, `isbot`, `react-router`, and `@react-router/express` to devDependencies since the build process bundles them entirely at build time
