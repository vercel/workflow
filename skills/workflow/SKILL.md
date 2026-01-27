---
name: workflow
description: Creates durable, resumable workflows using Vercel's Workflow DevKit. Use when building workflows that need to survive restarts, pause for external events, retry on failure, or coordinate multi-step operations over time. Triggers on mentions of "workflow", "durable functions", "resumable", "workflow devkit", or step-based orchestration.
metadata:
  author: Vercel Inc.
  version: '1.0'
---

## Workflow DevKit Documentation

When you need up-to-date information about the Workflow DevKit:

### Search Bundled Documentation

Search the bundled documentation in `node_modules/workflow/docs/`:

1. **Find docs**: `glob "node_modules/workflow/docs/**/*.mdx"`
2. **Search content**: `grep "your query" node_modules/workflow/docs/`

Documentation structure in `node_modules/workflow/docs/`:

- `getting-started/` - Framework setup (next.mdx, express.mdx, hono.mdx, etc.)
- `foundations/` - Core concepts (workflows-and-steps.mdx, hooks.mdx, streaming.mdx, etc.)
- `api-reference/workflow/` - API docs (sleep.mdx, create-hook.mdx, fatal-error.mdx, etc.)
- `api-reference/workflow-api/` - Client API (start.mdx, get-run.mdx, resume-hook.mdx, etc.)
- `ai/` - AI SDK integration docs
- `errors/` - Error code documentation

Related packages also include bundled docs:

- `@workflow/ai`: `node_modules/@workflow/ai/docs/` - DurableAgent and AI integration
- `@workflow/core`: `node_modules/@workflow/core/docs/` - Core runtime (foundations, how-it-works)
- `@workflow/next`: `node_modules/@workflow/next/docs/` - Next.js integration

**When in doubt, update to the latest version of the Workflow DevKit.**

### Official Resources

- **Website**: https://useworkflow.dev
- **GitHub**: https://github.com/vercel/workflow

### Quick Reference

**Directives:**

```typescript
"use workflow";  // First line - makes async function durable
"use step";      // First line - makes function a cached, retryable unit
```

**Essential imports:**

```typescript
// Workflow primitives
import { sleep, fetch, createHook, createWebhook, getWritable } from "workflow";
import { FatalError, RetryableError } from "workflow";
import { getWorkflowMetadata, getStepMetadata } from "workflow";

// API operations
import { start, getRun, resumeHook, resumeWebhook } from "workflow/api";

// Framework integrations
import { withWorkflow } from "workflow/next";
import { workflow } from "workflow/vite";
import { workflow } from "workflow/astro";
// Or use modules: ["workflow/nitro"] for Nitro/Nuxt
```

**Critical workflow rules:**

1. Always set `globalThis.fetch = fetch` when using AI SDK or HTTP libraries
2. Use `sleep()` instead of setTimeout/setInterval
3. Move Node.js modules (fs, crypto, etc.) to step functions
4. Use `FatalError` for permanent failures, `RetryableError` for retries
5. Use `use step` with AI SDK methods to avoid issues with OIDC

For common errors and troubleshooting, see [Common Errors Reference](references/common-errors.md).
