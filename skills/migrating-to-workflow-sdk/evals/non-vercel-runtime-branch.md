# non-vercel-runtime-branch

## Prompt

We are migrating a Temporal workflow to the Workflow SDK, but the app runs on Hono with self-hosted Postgres. Keep the migration examples framework-agnostic and do not assume managed execution.

## Must include

- migrated workflow / step structure
- a note that the workflow / step code can stay the same
- `World extends Storage, Queue, Streamer`
- `const world = await getWorld()` followed by `await world.start?.()` (not `getWorld().start?.()`, which never starts the World in v5)
- a startup helper like:

```ts
import { getWorld } from 'workflow/runtime';

export async function startWorkflowWorld(): Promise<void> {
  // getWorld() is async in v5: await it before calling start()
  const world = await getWorld();
  await world.start?.();
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
  // getWorld() is async in v5: await it before calling start()
  const world = await getWorld();
  await world.start?.();
}
```
