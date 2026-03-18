# Planning to delete after PR is implemented / ready to merge

# Flow Limits Design Notes

This note summarizes the current direction for flow concurrency and rate limiting
across `@workflow/core`, `@workflow/world`, and concrete world implementations.

## Status

- The shared `limits` interface and `lock()` API surface now exist.
- Local world has an initial working implementation for acquire/release/heartbeat.
- Postgres and Vercel worlds still expose `limits` as stubs.
- There is a real local E2E example for workflow and step locks in the Next.js Turbopack workbench.

## Goals

- Support keyed concurrency limits.
- Support keyed rate limits.
- Allow concurrency and rate to be colocated in one interface.
- Support workflow-scoped limits and step-scoped limits.
- Make crash recovery possible through leases with TTL/expiry.
- Keep worker throughput controls separate from business-level flow limits.

## Core Terms

- `worker concurrency`: backend throughput setting for queue/job processing.
- `workflow limit`: admission control for workflow runs that share a key.
- `step limit`: execution control for a specific step/resource key.
- `lease`: durable record that a workflow or step currently occupies capacity for a key.

## Decisions So Far

### 1. Use one shared limits model

The shared world interface uses a single `limits` namespace and a single limit
definition shape that can contain either or both:

- `concurrency`
- `rate`

This allows one key to express:

- concurrency only
- rate only
- both together

### 2. Use leases, not plain mutexes

Limits are modeled as leases with TTL/expiry so capacity can be recovered after:

- worker crashes
- process death
- machine shutdown
- lost retries

Normal completion should dispose/release the lease explicitly. Crash recovery
comes from lease expiry plus future reclaim logic.

### 3. Keep worker concurrency separate from flow limits

Current world-level concurrency settings are infrastructure controls, not
business-level locking:

- local world: `WORKFLOW_LOCAL_QUEUE_CONCURRENCY`
- postgres world: `WORKFLOW_POSTGRES_WORKER_CONCURRENCY`

These control how many queue jobs can be processed at once. They should remain
independent from flow limits like:

- `workflow:user:123`
- `step:db:cheap`
- `step:provider:openai`

### 4. Use a sliding-window model for rate limits in v1

The current rate-limit model is a sliding-window log model, not a token bucket.

For a limit like:

- `rate: { count: 10, periodMs: 60_000 }`

the intended semantics are:

- allow at most 10 successful acquires in the last 60 seconds
- each successful acquire records a timestamped rate usage entry
- rate capacity returns only when that entry ages out of the window

This is simpler than a token bucket and matches the current local-world
implementation direction well.

Important distinction:

- `lease`: active occupancy / ownership for a holder
- `token`: internal rate-usage record that remains until the rate window expires

Releasing a lease should free concurrency capacity immediately, but it should
not restore rate capacity until the associated rate usage entry expires.

### 5. Use one `lock()` API in both workflows and steps

We want one user-facing primitive:

```ts
await using lease = await lock({ ... });
```

But the runtime meaning differs by context.

#### In workflows

`lock()` means workflow admission / workflow-scope ownership.

If placed at the top of a workflow, it should hold the lease across the logical
workflow scope, even though the workflow may suspend and resume many times.

#### In steps

`lock()` should act like a step gate.

The intended long-term behavior is:

- declare the limit at the top of the step
- runtime/compiler hoists or interprets it as a pre-step requirement
- the step should not occupy a worker just waiting for capacity
- lease is disposed automatically when the step attempt completes

This means step `lock()` is conceptually the same API, but not a literal
"block inside already-running user step code" implementation.

### 6. `await using` is the preferred user-facing shape

The preferred API is explicit resource management:

```ts
await using lease = await lock({ ... });
```

This gives automatic cleanup on scope exit and reads well for both workflow
scopes and step scopes.

For manual early cleanup, the user-facing `LockHandle` should expose:

- `dispose()`
- `[Symbol.asyncDispose]()`

The backend-facing world contract can continue to use `release(...)` internally.

### 7. Workflow-scoped locks are logical-scope locks, not request-lifetime locks

For workflows, `await using` must be tied to the logical workflow scope across:

- step round trips
- queue turns
- sleeps
- hooks
- replay/resume

The lease must not be disposed merely because one host process invocation ends.

### 8. Prefer Option B for deadlock avoidance

Current preferred model:

- workflow-level limits may be held by a run
- step-level limits are acquired only at step boundaries
- step-level limits are short-lived
- step code should not acquire additional locks dynamically
- step execution should not wait on workflow-level locks

This keeps the dependency direction one-way:

- workflow admission -> step admission -> step execution

That avoids the classic cycle where one workflow holds a workflow lock and
another holds a step lock and each waits on the other.

### 9. V1 semantics are intentionally opinionated

For v1, the intended semantics are:

- workflow locks count admitted, in-flight workflows for a key
- step locks count or rate-limit specific step execution categories
- worker concurrency remains a separate infrastructure throttle

More concretely:

- if a workflow acquires a workflow-scoped lock and then sleeps for 10 minutes,
  it still counts as active for that workflow key during the sleep
- if a workflow is parked waiting for a step-level limit, it still counts as
  active for its workflow-level lock
- a step-level lock should conceptually be an admission gate for the step
  attempt, not a second workflow-level lock
- step-level rate limits should consume rate capacity when the step starts, and
  that rate usage should remain counted until the window expires even if the
  step releases its lease quickly

For the current local implementation specifically:

- workflow locks already behave like durable logical-scope leases
- step locks currently use in-process retry polling once the step is already
  executing, which is acceptable for local v1 but not the ideal long-term
  admission model

This means the current v1 interpretation of a workflow lock is:

- "How many workflows for this key are admitted and in flight at all?"

not:

- "How many workflows are actively burning CPU right this instant?"

## Current Example Shape

The current placeholder E2E example models:

- workflow-level user concurrency:
  - `workflow:user:${userId}`
- step-level DB concurrency:
  - `step:db:cheap`
- step-level AI rate limit:
  - `step:provider:openai`

With intended usage like:

```ts
async function cheapDbStep(userId: string) {
  'use step';
  await using _dbLimit = await lock({
    key: 'step:db:cheap',
    concurrency: { max: 20 },
  });
  return { userId, prompt: `profile:${userId}` };
}

async function expensiveAIStep(prompt: string) {
  'use step';
  await using _aiLimit = await lock({
    key: 'step:provider:openai',
    rate: { count: 10, periodMs: 60_000 },
  });
  return `summary:${prompt}`;
}

export async function workflowWithWorkflowAndStepLocks(userId: string) {
  'use workflow';
  await using userLimit = await lock({
    key: `workflow:user:${userId}`,
    concurrency: { max: 2 },
  });

  const row = await cheapDbStep(userId);
  const summary = await expensiveAIStep(row.prompt);
  return { row, summary };
}
```

## Important Clarification

Flow limits and worker concurrency are different layers.

For example:

- a cheap DB step may continue making progress even while an expensive AI step
  is rate-limited
- the main shared coupling between them is the worker pool
- if workers are available, unrelated step categories should continue

So overall system throughput is not one simple global minimum. Different
workflow paths may be bottlenecked by different limits at different times.

## Open Questions

- Exact runtime/compiler behavior for step-scoped `lock()` hoisting.
- Whether workflow-level locks should always be whole-run admission locks or
  also support narrower workflow-scoped blocks.
- Whether `heartbeat()` should remain user-visible or become mostly internal.
- Whether step limits should only be expressed through `lock()` or also through
  step metadata/config sugar.
- Fairness/wake-up policy for waiters per key in local and Postgres worlds.
- Exact event-log representation for acquire/block/dispose transitions.
