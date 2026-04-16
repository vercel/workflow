---
name: workflow
description: Creates durable, resumable workflows using Vercel's Workflow SDK. Use when building workflows that need to survive restarts, pause for external events, retry on failure, or coordinate multi-step operations over time. Triggers on mentions of "workflow", "durable functions", "resumable", "workflow sdk", "queue", "event", "push", "subscribe", or step-based orchestration.
metadata:
  author: Vercel Inc.
  version: '1.8'
---

## *CRITICAL*: Always Use Correct `workflow` Documentation

Your knowledge of `workflow` is outdated.

The `workflow` documentation outlined below matches the installed version of the Workflow SDK.
Follow these instructions before starting on any `workflow`-related tasks:

Search the bundled documentation in `node_modules/workflow/docs/`:

1. **Find docs**: `glob "node_modules/workflow/docs/**/*.mdx"`
2. **Search content**: `grep "your query" node_modules/workflow/docs/`

Documentation structure in `node_modules/workflow/docs/`:

- `getting-started/` - Framework setup (next.mdx, express.mdx, hono.mdx, etc.)
- `foundations/` - Core concepts (workflows-and-steps.mdx, hooks.mdx, streaming.mdx, etc.)
- `api-reference/workflow/` - API docs (sleep.mdx, create-hook.mdx, fatal-error.mdx, etc.)
- `api-reference/workflow-api/` - Client API (start.mdx, get-run.mdx, resume-hook.mdx, etc.)
- `api-reference/workflow-api/world/` - World SDK (runs.mdx, steps.mdx, hooks.mdx, events.mdx, streams.mdx, queue.mdx, observability.mdx)
- `ai/` - AI SDK integration docs
- `errors/` - Error code documentation

Related packages also include bundled docs:

- `@workflow/ai`: `node_modules/@workflow/ai/docs/` - DurableAgent and AI integration
- `@workflow/core`: `node_modules/@workflow/core/docs/` - Core runtime (foundations, how-it-works)
- `@workflow/next`: `node_modules/@workflow/next/docs/` - Next.js integration

**When in doubt, update to the latest version of the Workflow SDK.**

### Official Resources

- **Website**: https://workflow-sdk.dev
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

// Observability & data hydration
import { hydrateResourceIO, observabilityRevivers, parseStepName, parseWorkflowName } from "workflow/observability";

// Framework integrations
import { withWorkflow } from "workflow/next";
import { workflow } from "workflow/vite";
import { workflow } from "workflow/astro";
// Or use modules: ["workflow/nitro"] for Nitro/Nuxt

// AI agent
import { DurableAgent } from "@workflow/ai/agent";
```

## Prefer Step Functions to Avoid Sandbox Errors

`"use workflow"` functions run in a sandboxed VM. `"use step"` functions have **full Node.js access**. Put your logic in steps and use the workflow function purely for orchestration.

```typescript
// Steps have full Node.js and npm access
async function fetchUserData(userId: string) {
  "use step";
  const response = await fetch(`https://api.example.com/users/${userId}`);
  return response.json();
}

async function processWithAI(data: any) {
  "use step";
  // AI SDK works in steps without workarounds
  return await generateText({
    model: openai("gpt-4"),
    prompt: `Process: ${JSON.stringify(data)}`,
  });
}

// Workflow orchestrates steps - no sandbox issues
export async function dataProcessingWorkflow(userId: string) {
  "use workflow";
  const data = await fetchUserData(userId);
  const processed = await processWithAI(data);
  return { success: true, processed };
}
```

**Benefits:** Steps have automatic retry, results are persisted for replay, and no sandbox restrictions.

## Workflow Sandbox Limitations

When you need logic directly in a workflow function (not in a step), these restrictions apply:

| Limitation | Workaround |
|------------|------------|
| No `fetch()` | `import { fetch } from "workflow"` then `globalThis.fetch = fetch` |
| No `setTimeout`/`setInterval` | Use `sleep("5s")` from `"workflow"` |
| No Node.js modules (fs, crypto, etc.) | Move to a step function |

**Example - Using fetch in workflow context:**

```typescript
import { fetch } from "workflow";

export async function myWorkflow() {
  "use workflow";
  globalThis.fetch = fetch;  // Required for AI SDK and HTTP libraries
  // Now generateText() and other libraries work
}
```

**Note:** `DurableAgent` from `@workflow/ai` handles the fetch assignment automatically.

## DurableAgent — AI Agents in Workflows

Use `DurableAgent` to build AI agents that maintain state and survive interruptions. It handles the workflow sandbox automatically (no manual `globalThis.fetch` needed).

```typescript
import { DurableAgent } from "@workflow/ai/agent";
import { getWritable } from "workflow";
import { z } from "zod";
import type { UIMessageChunk } from "ai";

async function lookupData({ query }: { query: string }) {
  "use step";
  // Step functions have full Node.js access
  return `Results for "${query}"`;
}

export async function myAgentWorkflow(userMessage: string) {
  "use workflow";

  const agent = new DurableAgent({
    model: "anthropic/claude-sonnet-4-5",
    system: "You are a helpful assistant.",
    tools: {
      lookupData: {
        description: "Search for information",
        inputSchema: z.object({ query: z.string() }),
        execute: lookupData,
      },
    },
  });

  const result = await agent.stream({
    messages: [{ role: "user", content: userMessage }],
    writable: getWritable<UIMessageChunk>(),
    maxSteps: 10,
  });

  return result.messages;
}
```

**Key points:**
- `getWritable<UIMessageChunk>()` streams output to the workflow run's default stream
- Tool `execute` functions that need Node.js/npm access should use `"use step"`
- Tool `execute` functions that use workflow primitives (`sleep()`, `createHook()`) should **NOT** use `"use step"` — they run at the workflow level
- `maxSteps` limits the number of LLM calls (default is unlimited)
- Multi-turn: pass `result.messages` plus new user messages to subsequent `agent.stream()` calls

**For more details on `DurableAgent`, check the AI docs in `node_modules/@workflow/ai/docs/`.**

## Starting Workflows & Child Workflows

Use `start()` to launch workflows from API routes. **`start()` cannot be called directly in workflow context** — wrap it in a step function.

```typescript
import { start } from "workflow/api";

// From an API route — works directly
export async function POST() {
  const run = await start(myWorkflow, [arg1, arg2]);
  return Response.json({ runId: run.runId });
}

// No-args workflow
const run = await start(noArgWorkflow);
```

**Starting child workflows from inside a workflow — must use a step:**

```typescript
import { start } from "workflow/api";

// Wrap start() in a step function
async function triggerChild(data: string) {
  "use step";
  const run = await start(childWorkflow, [data]);
  return run.runId;
}

export async function parentWorkflow() {
  "use workflow";
  const childRunId = await triggerChild("some data");  // Fire-and-forget via step
  await sleep("1h");
}
```

`start()` returns immediately — it doesn't wait for the workflow to complete. Use `run.returnValue` to await completion.

## Hooks — Pause & Resume with External Events

Hooks let workflows wait for external data. Use `createHook()` inside a workflow and `resumeHook()` from API routes. Deterministic tokens are for `createHook()` + `resumeHook()` (server-side) only. `createWebhook()` always generates random tokens — do not pass a `token` option to `createWebhook()`.

### Single event

```typescript
import { createHook } from "workflow";

export async function approvalWorkflow() {
  "use workflow";

  const hook = createHook<{ approved: boolean }>({
    token: "approval-123",  // deterministic token for external systems
  });

  const result = await hook;  // Workflow suspends here
  return result.approved;
}
```

### Multiple events (iterable hooks)

Hooks implement `AsyncIterable` — use `for await...of` to receive multiple events:

```typescript
import { createHook } from "workflow";

export async function chatWorkflow(channelId: string) {
  "use workflow";

  const hook = createHook<{ text: string; done?: boolean }>({
    token: `chat-${channelId}`,
  });

  for await (const event of hook) {
    await processMessage(event.text);
    if (event.done) break;
  }
}
```

Each `resumeHook(token, payload)` call delivers the next value to the loop.

### Resuming from API routes

```typescript
import { resumeHook } from "workflow/api";

export async function POST(req: Request) {
  const { token, data } = await req.json();
  await resumeHook(token, data);
  return new Response("ok");
}
```

## Error Handling

Use `FatalError` for permanent failures (no retry), `RetryableError` for transient failures:

```typescript
import { FatalError, RetryableError } from "workflow";

if (res.status >= 400 && res.status < 500) {
  throw new FatalError(`Client error: ${res.status}`);
}
if (res.status === 429) {
  throw new RetryableError("Rate limited", { retryAfter: "5m" });
}
```

## Serialization

All data passed to/from workflows and steps must be serializable.

**Supported built-in types:** string, number, boolean, null, undefined, bigint, plain objects, arrays, Date, RegExp, URL, URLSearchParams, Map, Set, Headers, ArrayBuffer, typed arrays, Request, Response, ReadableStream, WritableStream.

**Not supported:** Functions, Symbols, WeakMap/WeakSet. Pass data, not callbacks.

### Custom Class Serialization

Class instances **can** be serialized across workflow/step boundaries by implementing the `@workflow/serde` protocol. This is essential when a class has instance methods with `"use step"` or when you want to pass class instances between steps.

**Install:** `@workflow/serde` must be a dependency of the package containing the class.

**Pattern:** Add two static methods inside the class body using computed property syntax:

```typescript
import { WORKFLOW_SERIALIZE, WORKFLOW_DESERIALIZE } from "@workflow/serde";

export class Point {
  x: number;
  y: number;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
  }

  // Serialize: return plain data (must be devalue-compatible types only)
  static [WORKFLOW_SERIALIZE](instance: Point) {
    return { x: instance.x, y: instance.y };
  }

  // Deserialize: reconstruct from plain data
  static [WORKFLOW_DESERIALIZE](data: { x: number; y: number }) {
    return new Point(data.x, data.y);
  }

  async computeDistance(other: Point) {
    "use step";
    return Math.sqrt((this.x - other.x) ** 2 + (this.y - other.y) ** 2);
  }
}
```

**Critical rules:**
1. **Define serde methods INSIDE the class body** as static methods with computed property syntax (`static [WORKFLOW_SERIALIZE](...)`). The SWC plugin detects them by scanning the class. Do NOT assign them externally (e.g., `(MyClass as any)[WORKFLOW_SERIALIZE] = ...`) -- the compiler will not detect this.
2. **Serde methods must return only devalue-compatible types** (plain objects, arrays, primitives, Date, Map, Set, Uint8Array, etc.). No functions, no class instances, no Node.js-specific objects.
3. **Add `"use step"` to Node.js-dependent instance methods.** The SWC plugin strips `"use step"` method bodies from the workflow bundle. This is how you keep Node.js imports (fs, crypto, child_process, etc.) out of the workflow sandbox. The class shell with its serde methods remains in the workflow bundle; only the step method bodies are removed.
4. **Do NOT manually register classes.** The SWC plugin automatically generates registration code (an IIFE that sets `classId` and adds the class to the global registry). Manual calls to `registerSerializationClass()` are unnecessary and error-prone.
5. **Do NOT use dynamic imports to work around sandbox restrictions.** If a class method needs Node.js APIs, the correct solution is `"use step"`, not `/* @vite-ignore */ import(...)`.

**When serde works well:** Pure data classes, domain models, configuration objects, and classes where Node.js-dependent methods can be marked with `"use step"`.

**When to avoid serde:** If a class is fundamentally inseparable from Node.js APIs (every method needs `fs`, `net`, etc.) and cannot meaningfully exist as a shell in the workflow sandbox, keep it entirely in step functions and pass plain data objects across boundaries instead.

### Validating Serde Compliance

Use these tools to verify classes are correctly set up:

- **`workflow transform <file> --check-serde`** -- Shows the SWC transform output for a file and checks if serde classes are compliant (no Node.js imports remaining in the workflow bundle).
- **`workflow validate`** -- Scans all workflow files and reports serde compliance issues. Use `--json` for machine-readable output.
- **SWC Playground** -- The web playground at `workbench/swc-playground` shows a Serde Analysis panel when serde patterns are detected.
- **Build-time warnings** -- The builder automatically warns when serde classes have Node.js built-in imports remaining in the workflow bundle.

## Streaming

Use `getWritable()` to stream data from workflows. `getWritable()` can be called in **both** workflow and step contexts, but you **cannot interact with the stream** (call `getWriter()`, `write()`, `close()`) directly in a workflow function. The stream must be passed to step functions for actual I/O, or steps can call `getWritable()` themselves.

**Get the stream in a workflow, pass it to a step:**
```typescript
import { getWritable } from "workflow";

export async function myWorkflow() {
  "use workflow";
  const writable = getWritable();
  await writeData(writable, "hello world");
}

async function writeData(writable: WritableStream, chunk: string) {
  "use step";
  const writer = writable.getWriter();
  try {
    await writer.write(chunk);
  } finally {
    writer.releaseLock();
  }
}
```

**Call `getWritable()` directly inside a step (no need to pass it):**
```typescript
import { getWritable } from "workflow";

async function streamData(chunk: string) {
  "use step";
  const writer = getWritable().getWriter();
  try {
    await writer.write(chunk);
  } finally {
    writer.releaseLock();
  }
}
```

### Namespaced Streams

Use `getWritable({ namespace: 'name' })` to create multiple independent streams for different types of data. This is useful for separating logs from primary output, different log levels, agent outputs, metrics, or any distinct data channels. Long-running workflows benefit from namespaced streams because you can replay only the important events (e.g., final results) while keeping verbose logs in a separate stream.

**Example: Log levels and agent output separation:**
```typescript
import { getWritable } from "workflow";

type LogEntry = { level: "debug" | "info" | "warn" | "error"; message: string; timestamp: number };
type AgentOutput = { type: "thought" | "action" | "result"; content: string };

async function logDebug(message: string) {
  "use step";
  const writer = getWritable<LogEntry>({ namespace: "logs:debug" }).getWriter();
  try {
    await writer.write({ level: "debug", message, timestamp: Date.now() });
  } finally {
    writer.releaseLock();
  }
}

async function logInfo(message: string) {
  "use step";
  const writer = getWritable<LogEntry>({ namespace: "logs:info" }).getWriter();
  try {
    await writer.write({ level: "info", message, timestamp: Date.now() });
  } finally {
    writer.releaseLock();
  }
}

async function emitAgentThought(thought: string) {
  "use step";
  const writer = getWritable<AgentOutput>({ namespace: "agent:thoughts" }).getWriter();
  try {
    await writer.write({ type: "thought", content: thought });
  } finally {
    writer.releaseLock();
  }
}

async function emitAgentResult(result: string) {
  "use step";
  // Important results go to the default stream for easy replay
  const writer = getWritable<AgentOutput>().getWriter();
  try {
    await writer.write({ type: "result", content: result });
  } finally {
    writer.releaseLock();
  }
}

export async function agentWorkflow(task: string) {
  "use workflow";
  
  await logInfo(`Starting task: ${task}`);
  await logDebug("Initializing agent context");
  await emitAgentThought("Analyzing the task requirements...");
  
  // ... agent processing ...
  
  await emitAgentResult("Task completed successfully");
  await logInfo("Workflow finished");
}
```

**Consuming namespaced streams:**
```typescript
import { start, getRun } from "workflow/api";
import { agentWorkflow } from "./workflows/agent";

export async function POST(request: Request) {
  const run = await start(agentWorkflow, ["process data"]);

  // Access specific streams by namespace
  const results = run.getReadable({ namespace: undefined }); // Default stream (important results)
  const infoLogs = run.getReadable({ namespace: "logs:info" });
  const debugLogs = run.getReadable({ namespace: "logs:debug" });
  const thoughts = run.getReadable({ namespace: "agent:thoughts" });

  // Return only important results for most clients
  return new Response(results, { headers: { "Content-Type": "application/json" } });
}

// Resume from a specific point (useful for long sessions)
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const runId = searchParams.get("runId")!;
  const startIndex = parseInt(searchParams.get("startIndex") || "0", 10);
  
  const run = getRun(runId);
  // Resume only the important stream, skip verbose debug logs
  const stream = run.getReadable({ startIndex });
  
  return new Response(stream);
}
```

**Pro tip:** For very long-running sessions (50+ minutes), namespaced streams help manage replay performance. Put verbose/debug output in separate namespaces so you can replay just the important events quickly.

## Debugging

```bash
# Check workflow endpoints are reachable
npx workflow health
npx workflow health --port 3001  # Non-default port

# Visual dashboard for runs
npx workflow web
npx workflow web <run_id>

# CLI inspection (use --json for machine-readable output, --help for full usage)
npx workflow inspect runs
npx workflow inspect run <run_id>

# For Vercel-deployed projects, specify backend and project
npx workflow inspect runs --backend vercel --project <project-name> --team <team-slug>
npx workflow inspect run <run_id> --backend vercel --project <project-name> --team <team-slug>

# Open Vercel dashboard in browser for a specific run
npx workflow inspect run <run_id> --web
npx workflow web <run_id> --backend vercel --project <project-name> --team <team-slug>

# Cancel a running workflow
npx workflow cancel <run_id>
npx workflow cancel <run_id> --backend vercel --project <project-name> --team <team-slug>
# --env defaults to "production"; use --env preview for preview deployments
```

**Debugging tips:**
- Use `--json` (`-j`) on any command for machine-readable output
- Use `--web` to open the Vercel Observability dashboard in your browser
- Use `--help` on any command for full usage details
- Only import workflow APIs you actually use. Unused imports can cause 500 errors.

## Testing Workflows

Workflow SDK provides a Vitest plugin for testing workflows in-process — no running server required.

**Unit testing steps:** Steps are just functions; without the compiler, `"use step"` is a no-op. Test them directly:

```typescript
import { describe, it, expect } from "vitest";
import { createUser } from "./user-signup";

describe("createUser step", () => {
  it("should create a user", async () => {
    const user = await createUser("test@example.com");
    expect(user.email).toBe("test@example.com");
  });
});
```

**Integration testing:** Use `@workflow/vitest` for workflows using `sleep()`, hooks, webhooks, or retries:

```typescript
// vitest.integration.config.ts
import { defineConfig } from "vitest/config";
import { workflow } from "@workflow/vitest";

export default defineConfig({
  plugins: [workflow()],
  test: {
    include: ["**/*.integration.test.ts"],
    testTimeout: 60_000,
  },
});
```

```typescript
// approval.integration.test.ts
import { describe, it, expect } from "vitest";
import { start, getRun, resumeHook } from "workflow/api";
import { waitForHook, waitForSleep } from "@workflow/vitest";
import { approvalWorkflow } from "./approval";

describe("approvalWorkflow", () => {
  it("should publish when approved", async () => {
    const run = await start(approvalWorkflow, ["doc-123"]);

    // Wait for the hook, then resume it
    await waitForHook(run, { token: "approval:doc-123" });
    await resumeHook("approval:doc-123", { approved: true, reviewer: "alice" });

    // Wait for sleep, then wake it up
    const sleepId = await waitForSleep(run);
    await getRun(run.runId).wakeUp({ correlationIds: [sleepId] });

    const result = await run.returnValue;
    expect(result).toEqual({ status: "published", reviewer: "alice" });
  });
});
```

**Testing webhooks:** Use `resumeWebhook()` with a `Request` object — no HTTP server needed:

```typescript
import { start, resumeWebhook } from "workflow/api";
import { waitForHook } from "@workflow/vitest";

const run = await start(ingestWorkflow, ["ep-1"]);
const hook = await waitForHook(run);  // Discovers the random webhook token
await resumeWebhook(hook.token, new Request("https://example.com/webhook", {
  method: "POST",
  body: JSON.stringify({ event: "order.created" }),
}));
```

**Key APIs:**
- `start()` — trigger a workflow
- `run.returnValue` — await workflow completion
- `waitForHook(run, { token? })` / `waitForSleep(run)` — wait for workflow to reach a pause point
- `resumeHook(token, data)` / `resumeWebhook(token, request)` — resume paused workflows
- `getRun(runId).wakeUp({ correlationIds })` — skip `sleep()` calls

**Best practices:**
- Keep unit tests (no plugin) and integration tests (`workflow()` plugin) in separate configs
- Use deterministic hook tokens based on test data for easier resumption
- Set generous `testTimeout` — workflows may run longer than typical unit tests
- `vi.mock()` does **not** work in integration tests — step dependencies are bundled by esbuild

## Observability & World SDK

Use `await getWorld()` to build observability dashboards, admin panels, and inspect workflow state. `getWorld()` is asynchronous and returns `Promise<World>` (dynamic import / env-based setup).

**Key imports:**
```typescript
import { getWorld } from "workflow/runtime";
import { hydrateResourceIO, observabilityRevivers, parseStepName, parseWorkflowName } from "workflow/observability";
```

**Key docs** (grep `node_modules/workflow/docs/` for full details):
- `api-reference/workflow-api/world/storage.mdx` — events, runs, steps, hooks (events are source of truth; others are materialized views)
- `api-reference/workflow-api/world/observability.mdx` — hydration, parsing, encryption

### World SDK Method Signatures

⚠️ Pagination is nested: `{ pagination: { cursor } }` — NOT `{ cursor }` directly.

```typescript
const world = await getWorld();

// Runs
const { data, cursor } = await world.runs.list({ pagination: { cursor }, resolveData: 'all' | 'none' });
const run = await world.runs.get(runId, { resolveData: 'all' | 'none' });
// Cancel via event creation (no cancel() method on runs)
await world.events.create(runId, { eventType: 'run_cancelled' });

// Steps — runId is top-level, NOT inside pagination
const { data, cursor } = await world.steps.list({ runId, pagination: { cursor }, resolveData: 'all' | 'none' });
const step = await world.steps.get(runId, stepId, { resolveData: 'all' | 'none' });

// Events
const { data, cursor } = await world.events.list({ runId, pagination: { cursor } });
await world.events.create(runId, { eventType: 'run_cancelled' });

// Hooks
const hook = await world.hooks.get(hookId);
const hook = await world.hooks.getByToken(token);

// Streams (methods on world.streams)
await world.streams.write(runId, name, chunk);
await world.streams.writeMulti?.(runId, name, chunks);
const readable = await world.streams.get(runId, name, startIndex);
await world.streams.close(runId, name);
const streamNames = await world.streams.list(runId);
const chunks = await world.streams.getChunks(runId, name, { limit, cursor });
const info = await world.streams.getInfo(runId, name);

// Queue (methods live directly on world — internal SDK infrastructure)
await world.queue(queueName, payload, opts);
const deploymentId = await world.getDeploymentId();
```

### `resolveData` Parameter

Controls whether input/output data is **included** in the response. Accepts `'all'` (default) or `'none'`.

**IMPORTANT**: Even with `'all'`, data is still devalue-serialized. You MUST call `hydrateResourceIO()` to get usable JS values.

- **Use `'none'`** for status polling, progress dashboards, run listings
- **Use `'all'`** (or omit) when you need to inspect actual step I/O data — then **always hydrate**

```typescript
// Lightweight status check — no I/O loaded
const run = await world.runs.get(runId, { resolveData: 'none' });
console.log(run.status); // 'running' | 'completed' | 'failed' | 'cancelled'

// Full inspection — resolveData includes data, hydrateResourceIO deserializes it
const step = await world.steps.get(runId, stepId); // defaults to 'all'
const hydrated = hydrateResourceIO(step, observabilityRevivers);
```

> **Common mistake**: Checking `step.input !== undefined` after `resolveData: 'all'` and assuming
> the data is ready to use. The data exists but is serialized — always hydrate first.

### Data Hydration (Devalue Format)

Step I/O is serialized via [devalue](https://github.com/Rich-Harris/devalue) with a 4-byte format prefix (`devl`). Without hydration, `input`/`output` are Uint8Array-like objects with numeric keys:
`{"0":100,"1":101,"2":118,"3":108,...}` — these are NOT usable values.

**Always hydrate before using I/O data:**

```typescript
import { hydrateResourceIO, observabilityRevivers } from "workflow/observability";

const { data: steps } = await world.steps.list({ runId, resolveData: 'all' });
const hydrated = steps.map(s => hydrateResourceIO(s, observabilityRevivers));
// hydrated[0].input → [123, 2] (actual function arguments)
// hydrated[0].output → 125 (actual return value)
```

`hydrateResourceIO` works on both `Step` and `WorkflowRun` objects. For encrypted workflows, use `getEncryptionKeyForRun()` + `hydrateResourceIOWithKey()`.

### Name Parsing

`parseWorkflowName()`, `parseStepName()`, and `parseClassName()` return `{ shortName: string, moduleSpecifier: string } | null`. Always use optional chaining:

```typescript
const parsed = parseWorkflowName("workflow//./src/workflows/order//processOrder");
// parsed?.shortName → "processOrder"
// parsed?.moduleSpecifier → "./src/workflows/order"
// ⚠️ Returns null if format doesn't match
```

### Event Types

Events are the append-only source of truth. Runs/Steps/Hooks are materialized views.

| Category | Types |
|----------|-------|
| Run | `run_created`, `run_started`, `run_completed`, `run_failed`, `run_cancelled` |
| Step | `step_created`, `step_started`, `step_completed`, `step_failed`, `step_retrying` |
| Hook | `hook_created`, `hook_received`, `hook_disposed`, `hook_conflict` |
| Wait | `wait_created`, `wait_completed` |

## Error Handling Patterns

Three error strategies for different failure modes:

| Error Type | Use When | Behavior |
|------------|----------|----------|
| `FatalError` | Permanent failure (bad input, auth denied) | Terminates workflow immediately, no retry |
| `RetryableError` | Transient failure (rate limit, timeout) | Retries with optional `retryAfter` delay |
| `Promise.allSettled` | Parallel steps with mixed criticality | Continues even if some steps fail |

```typescript
import { FatalError, RetryableError } from "workflow";

// Permanent failure — workflow terminates
throw new FatalError("Invalid input: missing required field");

// Transient failure — will retry
throw new RetryableError("API rate limited", { retryAfter: "5m" });

// Mixed criticality parallel execution
const results = await Promise.allSettled([
  criticalStep(data),    // Must succeed
  optionalStep(data),    // OK to fail
  enrichmentStep(data),  // OK to fail
]);
const [critical, optional, enrichment] = results;
if (critical.status === "rejected") throw new FatalError(critical.reason);
```
