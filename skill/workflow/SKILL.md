---
name: workflow
description: Creates durable, resumable workflows using Vercel's Workflow DevKit. Use when building workflows that need to survive restarts, pause for external events, retry on failure, or coordinate multi-step operations over time. Triggers on mentions of "workflow", "durable functions", "resumable", "workflow devkit", or step-based orchestration.
---

# Workflow DevKit

TypeScript framework for building durable, resumable functions. Workflows survive crashes, deployments, and can pause for days/months.

**Website:** https://useworkflow.dev | **GitHub:** https://github.com/vercel/workflow

## Installation

```bash
npm i workflow
# or: pnpm add workflow | yarn add workflow | bun add workflow
```

**Version Note:** The Workflow DevKit is in beta. Consider pinning to a specific version (e.g., `workflow@4.0.1-beta.44`) rather than `"latest"` to avoid unexpected breaking changes.

## Core Concepts

### Directives

```typescript
"use workflow";  // First line - makes async function durable
"use step";      // First line - makes function a cached, retryable unit
```

### Workflow Function

Orchestrates steps, survives restarts, replays deterministically:

```typescript
import { sleep } from "workflow";

export async function onboardUser(email: string) {
  "use workflow";

  const user = await createUser(email);      // Step 1
  await sendWelcomeEmail(user);              // Step 2
  await sleep("3 days");                     // Pause (no resources consumed)
  await sendFollowupEmail(user);             // Step 3
  return { userId: user.id };
}
```

### Step Function

Has full Node.js access, auto-retries on failure:

```typescript
async function createUser(email: string) {
  "use step";
  return await db.users.create({ email });
}
```

## Essential APIs

### sleep - Pause Workflow

```typescript
import { sleep } from "workflow";

await sleep("5s");      // 5 seconds
await sleep("10m");     // 10 minutes
await sleep("1h");      // 1 hour
await sleep("7 days");  // 7 days
await sleep(5000);      // milliseconds
await sleep(new Date("2027-01-01")); // specific date
```

### createHook - Wait for External Input

```typescript
import { createHook } from "workflow";

const hook = createHook<{ approved: boolean }>();
console.log("Token:", hook.token);  // Send to external system
const result = await hook;          // Pauses until resumed
```

Resume externally:
```typescript
import { resumeHook } from "workflow/api";
await resumeHook(token, { approved: true });
```

### createWebhook - HTTP Callback Endpoint

```typescript
import { createWebhook } from "workflow";

const webhook = createWebhook();
await sendToExternalService(webhook.url);  // Auto-generated URL
const request = await webhook;              // Pauses until HTTP POST
const data = await request.json();
```

### start - Trigger Workflow

```typescript
import { start } from "workflow/api";

const run = await start(onboardUser, ["user@example.com"]);
console.log(run.runId);  // Returns immediately
```

### Error Handling

```typescript
import { FatalError, RetryableError } from "workflow";

// Stop retries permanently
throw new FatalError("User not found");

// Retry with delay
throw new RetryableError("Rate limited", { retryAfter: "5m" });
```

### Parallel Execution

```typescript
// Execute steps concurrently
const [user, settings, history] = await Promise.all([
  fetchUser(userId),
  fetchSettings(userId),
  fetchHistory(userId),
]);

// Race: first to complete wins (useful for timeouts)
const result = await Promise.race([
  processTask(taskId),
  (async () => { await sleep("30s"); return { timeout: true }; })(),
]);
```

## Fetch in Workflows

Workflows run sandboxed. Import fetch from workflow:

```typescript
import { fetch } from "workflow";

export async function myWorkflow() {
  "use workflow";
  globalThis.fetch = fetch;  // Enable for libraries (AI SDK)

  const response = await fetch("https://api.example.com/data");
}
```

## Streaming (Steps Only)

```typescript
import { getWritable } from "workflow";

async function streamData(items: string[]) {
  "use step";
  const writer = getWritable();
  for (const item of items) {
    await writer.write({ item });
  }
  writer.releaseLock();
}
```

## Metadata & Idempotency

### Workflow Metadata

Get context about the current workflow run:

```typescript
import { getWorkflowMetadata } from "workflow";

export async function myWorkflow() {
  "use workflow";
  const { workflowRunId, workflowStartedAt, url } = getWorkflowMetadata();
  console.log(`Run ${workflowRunId} started at ${workflowStartedAt}`);
}
```

### Step Metadata for Idempotency

Use stepId for external API calls to prevent duplicate operations:

```typescript
import { getStepMetadata } from "workflow";

async function chargeCard(amount: number) {
  "use step";
  const { stepId, attempt, stepStartedAt } = getStepMetadata();
  await stripe.charges.create(
    { amount },
    { idempotencyKey: `charge:${stepId}` }
  );
}
```

## Custom Class Serialization

Class instances can be serialized by implementing static methods:

```typescript
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from "@workflow/serde";

class Point {
  constructor(public x: number, public y: number) {}

  static [WORKFLOW_SERIALIZE](instance: Point) {
    return { x: instance.x, y: instance.y };
  }

  static [WORKFLOW_DESERIALIZE](data: { x: number; y: number }) {
    return new Point(data.x, data.y);
  }
}
```

## What Cannot Be Serialized

- Functions/callbacks (except step functions) - define logic in steps
- Class instances without custom serialization methods
- Symbols, WeakMap, WeakSet
- Node.js modules (fs, http, crypto) - use in steps only

## Run Status

`pending | running | completed | failed | cancelled`

## References

- **Framework Setup:** See [frameworks.md](references/frameworks.md) for Next.js, Express, Hono, Vite, Astro, Fastify, Nitro, Nuxt, SvelteKit
- **AI Agents:** See [ai-agents.md](references/ai-agents.md) for DurableAgent and streaming patterns
- **Advanced Patterns:** See [patterns.md](references/patterns.md) for hooks, webhooks, control flow, batching, streaming
- **Common Errors:** See [errors.md](references/errors.md) for troubleshooting
- **API Reference:** See [api-reference.md](references/api-reference.md) for complete API

## Local Development

```bash
# Terminal 1: Start your app on default port
npm run dev

# Terminal 2: Open dashboard (connects to port 3000)
npx workflow web

# If app runs on different port:
npx workflow web --app-url http://localhost:3001
```

Dashboard at `http://localhost:3456` shows workflows and runs. If runs don't appear, restart dashboard after app is running.

## Quick Checklist

- [ ] Add `"use workflow"` as first line of workflow function
- [ ] Add `"use step"` as first line of step functions
- [ ] Import `fetch` from `workflow` and assign to `globalThis.fetch`
- [ ] Use `sleep()` instead of setTimeout
- [ ] Move Node.js module usage to step functions
- [ ] Use `FatalError` for permanent failures, `RetryableError` for retries
- [ ] Configure framework (withWorkflow, nitro module, etc.)
- [ ] Run dashboard with correct `--app-url` if not using port 3000
