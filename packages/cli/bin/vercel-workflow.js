#!/usr/bin/env node

// Entry point for `vercel workflow` (`vc workflow`). Vercel CLI runs
// `node_modules/.bin/vercel-workflow` as a CLI extension, so the Vercel
// backend is the default here. `--backend` and `WORKFLOW_TARGET_WORLD` still
// take precedence.
import { setDefaultBackend } from '../dist/lib/inspect/default-backend.js';

setDefaultBackend('vercel');

await import('./run.js');
