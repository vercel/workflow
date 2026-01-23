# Complete API Reference

## workflow package

### sleep(duration)

Pause workflow without consuming resources.

```typescript
import { sleep } from "workflow";

await sleep("5s");              // String duration
await sleep("10m");             // 10 minutes
await sleep("1h");              // 1 hour
await sleep("7 days");          // 7 days
await sleep(5000);              // Milliseconds
await sleep(new Date("2025-12-31"));  // Until specific date
```

**Duration formats:** `${number}${'ms'|'s'|'m'|'h'|'d'}`

### fetch(url, options)

HTTP request with automatic retry. Use instead of global fetch.

```typescript
import { fetch } from "workflow";

export async function myWorkflow() {
  "use workflow";
  globalThis.fetch = fetch;  // Enable for libraries

  const response = await fetch("https://api.example.com/data");
  const data = await response.json();
}
```

### createHook<T>(options?)

Create suspension point for external input.

```typescript
import { createHook } from "workflow";

const hook = createHook<{ approved: boolean }>();
// hook.token - string identifier for resumption
const result = await hook;  // Pauses until resumed
```

**Options:**
- `token?: string` - Custom deterministic token
- `metadata?: any` - Attached metadata

**Returns:** `Hook<T>` - PromiseLike & AsyncIterable

### defineHook<I, O>(config)

Type-safe hook with schema validation.

```typescript
import { defineHook } from "workflow";
import { z } from "zod";

const myHook = defineHook({
  schema: z.object({
    id: z.string(),
    value: z.number(),
  }),
});

// Create hook
const hook = myHook.create({ token: `custom:${id}` });

// Resume with validation
await myHook.resume(`custom:${id}`, { id: "123", value: 42 });
```

### createWebhook(options?)

Create HTTP webhook endpoint.

```typescript
import { createWebhook } from "workflow";

const webhook = createWebhook();
console.log(webhook.url);  // Auto-generated URL
const request = await webhook;  // Pauses until HTTP POST
```

**Options:**
- `token?: string` - Custom token
- `metadata?: any` - Attached metadata
- `respondWith?: Response | "manual"` - Response mode

**Returns:** `Webhook<Request>` - PromiseLike & AsyncIterable with `.url`

### getWritable<T>(options?)

Access stream writer (steps only).

```typescript
import { getWritable } from "workflow";

async function streamStep() {
  "use step";

  const writer = getWritable();
  await writer.write({ data: "chunk" });
  writer.releaseLock();
}
```

**Options:**
- `namespace?: string` - Stream namespace

**Returns:** `WritableStream<T>`

### getWorkflowMetadata()

Get workflow run context.

```typescript
import { getWorkflowMetadata } from "workflow";

export async function myWorkflow() {
  "use workflow";

  const { runId, workflowName } = getWorkflowMetadata();
}
```

### getStepMetadata()

Get step execution context.

```typescript
import { getStepMetadata } from "workflow";

async function myStep() {
  "use step";

  const { stepId, attemptNumber } = getStepMetadata();
  // Use stepId for idempotency keys
}
```

### FatalError

Stop retries permanently.

```typescript
import { FatalError } from "workflow";

throw new FatalError("User not found");
throw new FatalError("Invalid input", { cause: originalError });
```

### RetryableError

Trigger retry with delay.

```typescript
import { RetryableError } from "workflow";

throw new RetryableError("Rate limited", { retryAfter: "5m" });
throw new RetryableError("Retry", { retryAfter: 5000 });
throw new RetryableError("Retry", { retryAfter: new Date("2025-01-01") });
```

---

## workflow/api package

### start(workflow, args, options?)

Start workflow run.

```typescript
import { start } from "workflow/api";

const run = await start(myWorkflow, ["arg1", "arg2"]);
console.log(run.runId);

// With options
const run = await start(myWorkflow, ["arg1"], {
  runId: "custom-id",
});
```

**Returns:** `Run<T>` object

### Run<T> object

```typescript
interface Run<T> {
  runId: string;

  // Get current status
  get status(): Promise<RunStatus>;

  // Get return value (waits for completion)
  get returnValue(): Promise<T>;

  // Cancel the run
  cancel(): Promise<void>;

  // Get readable stream
  getReadable<R>(options?: { namespace?: string }): ReadableStream<R>;
}
```

### getRun(runId)

Get existing run by ID.

```typescript
import { getRun } from "workflow/api";

const run = getRun<ReturnType>("run-id");
const status = await run.status;
const result = await run.returnValue;
```

### resumeHook(token, data)

Resume workflow via hook.

```typescript
import { resumeHook } from "workflow/api";

const result = await resumeHook(token, { approved: true });
// result.runId, result.hookId
```

### resumeWebhook(token, request)

Resume workflow via webhook.

```typescript
import { resumeWebhook } from "workflow/api";

await resumeWebhook(token, incomingRequest);
```

### getHookByToken(token)

Get hook metadata.

```typescript
import { getHookByToken } from "workflow/api";

const hook = await getHookByToken(token);
// hook.status: 'pending' | 'received' | 'disposed'
```

### getWorld()

Access low-level infrastructure.

```typescript
import { getWorld } from "workflow/api";

const world = getWorld();
const runs = await world.runs.list({ pagination: { cursor } });
```

---

## Types

### RunStatus

```typescript
type RunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
```

### EventType

```typescript
type EventType =
  | 'step_completed' | 'step_failed' | 'step_retrying' | 'step_started'
  | 'hook_created' | 'hook_received' | 'hook_disposed'
  | 'wait_created' | 'wait_completed'
  | 'workflow_completed' | 'workflow_failed' | 'workflow_started';
```

### Serializable Types

```typescript
type Serializable =
  | string | number | boolean | null | undefined | bigint
  | Serializable[]
  | { [key: string]: Serializable }
  | Date | URL | RegExp | URLSearchParams
  | Map<Serializable, Serializable> | Set<Serializable>
  | Response | Request | Headers
  | ArrayBuffer | Uint8Array | Int8Array | Float64Array  // all typed arrays
  | ReadableStream | WritableStream;
```

---

## Framework Exports

### workflow/next

```typescript
import { withWorkflow } from "workflow/next";

export default withWorkflow(nextConfig);
```

### workflow/vite

```typescript
import { workflow } from "workflow/vite";

export default defineConfig({
  plugins: [workflow()],
});
```

### workflow/astro

```typescript
import { workflow } from "workflow/astro";

export default defineConfig({
  integrations: [workflow()],
});
```

### workflow/nitro

```typescript
// nitro.config.ts
export default defineNitroConfig({
  modules: ["workflow/nitro"],
});
```

### workflow/nuxt

```typescript
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ["workflow/nuxt"],
});
```

### workflow/sveltekit

```typescript
import { workflowPlugin } from "workflow/sveltekit";

export default {
  plugins: [sveltekit(), workflowPlugin()],
};
```

---

## @workflow/ai

### DurableAgent

```typescript
import { DurableAgent } from "@workflow/ai/agent";

const agent = new DurableAgent({
  model: string,
  system?: string,
  temperature?: number,
  tools?: Record<string, ToolDefinition>,
  toolChoice?: "auto" | "required" | "none" | string,
  maxSteps?: number,
  onFinish?: (result) => void,
  onError?: (error) => void,
  onAbort?: () => void,
  onStepFinish?: (step) => void,
});

await agent.stream({ messages, writable });
```

### WorkflowChatTransport

```typescript
import { WorkflowChatTransport } from "@workflow/ai";

const transport = new WorkflowChatTransport({
  maxConsecutiveErrors?: number,
  onChatSendMessage?: (response) => void,
  onChatEnd?: ({ chatId, chunkIndex }) => void,
});
```

---

## Worlds

### @workflow/world-local

Local development with filesystem storage.

```typescript
// Auto-used in development
// Data in .workflow-data/ or .next/workflow-data/
```

### @workflow/world-vercel

Production on Vercel with durable queues.

```typescript
// Auto-used when deployed to Vercel
// No configuration needed
```

### @workflow/world-postgres

Self-hosted PostgreSQL backend.

```typescript
import { PostgresWorld } from "@workflow/world-postgres";
```

### @workflow/world-testing

Testing utilities.

```typescript
import { TestWorld } from "@workflow/world-testing";
```
