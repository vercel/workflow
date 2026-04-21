---
"@workflow/web": patch
---

Configure `vercelPreset()` from `@vercel/react-router/vite` in `react-router.config.ts` when building the `packages/web` project for the Vercel deployment, enabling per-route bundle splitting, function-level configuration, and an accurate Deployment Summary.

The preset is gated on a new `WORKFLOW_WEB_VERCEL_BUILD` environment variable (rather than the ambient `VERCEL` var) so that the standard build layout consumed by `server.js` (self-hosted deployments and the CLI's in-process server via `@workflow/web/server`) is still produced when the package is packed as a tarball by the `docs` Vercel deployment. Set `WORKFLOW_WEB_VERCEL_BUILD=1` in the web Vercel project's environment variables to enable the preset there. The existing `VERCEL`-based checks in `vite.config.ts` have been migrated to this same variable for consistency.
