#!/usr/bin/env node

// Entry point for `vercel workflow` (`vc workflow`). Vercel CLI runs
// `node_modules/.bin/vercel-workflow` as a CLI extension and passes the URL of
// an API proxy that carries the user's Vercel CLI login in `VERCEL_API`. Run
// this way, the Vercel backend is the default and Vercel API requests go
// through that proxy. `--backend`, `WORKFLOW_TARGET_WORLD` and an explicit
// `--authToken` still take precedence.
import { setRunAsVercelExtension } from '../dist/lib/inspect/vercel-extension.js';

setRunAsVercelExtension(process.env.VERCEL_API);

await import('./run.js');
