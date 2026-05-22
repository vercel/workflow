# Runtime targets

## Use managed execution when

- The app is deploying to a managed platform.
- The user wants zero-config workflow storage, queueing, and streaming.

Guidance:

- Start workflows from the app boundary with `start()`.
- Retrieve runs later with `getRun()`.
- Do not invent custom `World` code unless the task requires it.

## Use a custom World when

- The app is self-hosted.
- The app is not deploying to a managed platform.
- The task explicitly asks for custom infrastructure.

State this explicitly in the migration output:

- The workflow and step code can stay the same.
- The app still needs a `World` implementation for storage, queueing, and streaming.
- The server startup path must call `await getWorld().start?.()` when the selected world requires background workers.

Minimum interface to mention:

```ts
interface World extends Queue, Streamer, Storage {
  start?(): Promise<void>;
}
```

Bootstrap example for self-hosted runtimes:

```ts
import { getWorld } from 'workflow/runtime';

export async function startWorkflowWorld(): Promise<void> {
  await getWorld().start?.();
}
```

## Required responsibilities

- **Storage** for runs, steps, hooks, waits, and the event log.
- **Queueing** for workflow and step invocations.
- **Streaming** for readable/writable workflow streams.

## Self-hosted output block

When the target is self-hosted, include this explanation almost verbatim:

> The workflow and step code can stay the same. Because this target is self-hosted, the app still needs a `World` implementation for storage, queueing, and streaming, plus a startup path that calls `await getWorld().start?.()` when the selected world runs background workers.

Framework-agnostic app boundary:

```ts
import { start } from 'workflow/api';
import { onboardingWorkflow } from '../workflows/onboarding';

export async function POST(request: Request) {
  const body = (await request.json()) as { userId: string };
  const run = await start(onboardingWorkflow, [body.userId]);
  return Response.json({ runId: run.runId });
}
```

Named-framework app boundary example (Hono):

```ts
import { Hono } from 'hono';
import { start } from 'workflow/api';
import { onboardingWorkflow } from '../workflows/onboarding';

const app = new Hono();

app.post('/api/onboarding/start', async (c) => {
  const body = (await c.req.json()) as { userId: string };
  const run = await start(onboardingWorkflow, [body.userId]);
  return c.json({ runId: run.runId });
});

export default app;
```

Startup bootstrap:

```ts
import { getWorld } from 'workflow/runtime';

export async function startWorkflowWorld(): Promise<void> {
  await getWorld().start?.();
}
```

**Sample input:** `We are migrating a Temporal workflow to the Workflow SDK, but the app runs on Hono with self-hosted Postgres. Keep the migration examples framework-agnostic and do not assume managed execution.`

**Expected output:** The migration explicitly says the workflow/step code can stay the same, includes `World extends Queue, Streamer, Storage`, shows `startWorkflowWorld(): Promise<void>`, and keeps the route example on plain `Request` / `Response` because the prompt explicitly asks for framework-agnostic app-boundary code.

## Framework rule

Apply these in order:

1. If the prompt explicitly asks for framework-agnostic app-boundary examples, use plain `Request` / `Response` even when a framework like Hono is named.
2. Otherwise, if the target framework is named, shape every user-authored app-boundary snippet to that framework.
3. Otherwise, keep examples framework-agnostic with `Request` / `Response`. Do not default to Next.js-only route signatures unless Next.js is explicitly named.

For `createWebhook()` migrations, the generated `webhook.url` is the callback surface. Do not invent a separate framework callback route unless the prompt explicitly asks for one.
