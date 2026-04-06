# non-vercel-runtime-branch

## Prompt

We are migrating a Temporal workflow to the Workflow SDK, but the app runs on Hono with self-hosted Postgres. Keep the migration examples framework-agnostic and do not assume managed execution.

## Must include

- migrated workflow / step structure
- a note that the workflow / step code can stay the same
- `World extends Storage, Queue, Streamer`
- `await getWorld().start?.()`
- a startup helper like:

```ts
import { getWorld } from 'workflow/runtime';

export async function startWorkflowWorld(): Promise<void> {
  await getWorld().start?.();
}
```

- app-boundary `start()` guidance without Next.js-only route syntax

## Must not include

- claims that no infrastructure work is needed
- Next.js-only handler signatures
- claims that managed execution is automatic in this target environment

## Expected excerpt

```ts
interface World extends Storage, Queue, Streamer {
  start?(): Promise<void>;
}
```

```ts
import { getWorld } from 'workflow/runtime';

export async function startWorkflowWorld(): Promise<void> {
  await getWorld().start?.();
}
```
