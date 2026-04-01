# Flow Limits Design Notes

This note summarizes the implemented direction for flow concurrency and rate
limiting across `@workflow/core`, `@workflow/world`, and concrete world
implementations.

## Status

- The shared `limits` interface and `lock()` API surface now exist.
- Local world now implements the shared live-process limits semantics with
  leases, rate tokens, FIFO waiters, and prompt wake-up with delayed fallback.
- Postgres implements the same limits semantics with PostgreSQL-backed leases,
  rate tokens, durable waiters, and durable queue wake-up.
- Vercel still exposes `limits` as a stub.
- The Next.js Turbopack workbench has shared E2E coverage for `lock()` used
  with `await using`, including locks that wrap individual step calls or
  groups of steps.

## Goals

- Support keyed concurrency limits.
- Support keyed rate limits.
- Allow concurrency and rate to be colocated in one interface.
- Support locks whose lifetime follows normal `await using` lexical scope.
- Make crash recovery possible through leases with TTL/expiry.
- Keep worker throughput controls separate from business-level flow limits.

## Core Terms

- `worker concurrency`: backend throughput setting for queue/job processing.
- `workflow limit`: admission control for workflow runs that share a key.
- `scoped resource key`: any user-defined key acquired from workflow scope to
  protect one step call, multiple step calls, or a whole workflow section.
- `lease`: durable record that a workflow currently occupies capacity for a
  key.

## Shared Contract vs World-Specific Behavior

The limits contract is intended to describe one shared set of observable
semantics across implemented worlds. That shared contract includes:

- `acquire()`, `release()`, and `heartbeat()` surface behavior
- `WorkflowWorldError` when heartbeating a missing lease
- per-key concurrency and rate limiting outcomes
- same-holder lease reuse
- serialization of concurrent acquires for a single key
- FIFO waiter promotion per key
- pruning terminal workflow holders and waiters
- blocked acquisitions not consuming execution concurrency
- prompt wake-up with delayed fallback replay

World-specific behavior should be limited to implementation mechanics and
durability characteristics, for example:

- how waiter state is stored internally
- how per-key mutations are serialized internally
- how prompt wake-up is delivered
- whether queued wake-ups survive process or host loss
- backend-specific observability or debugging surfaces

That means SQL row layout, advisory locks, and Graphile jobs are PostgreSQL
implementation details, while FIFO fairness and waiter skipping are contract
behavior that local and Postgres should both exhibit.

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

The default workflow lock TTL should be high enough to cover normal suspended
execution without making users tune it eagerly. The current runtime default is
24 hours unless the caller overrides `leaseTtlMs`.

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

### 4. Rate-limited waits are scheduled with `acquireAt`

For a rate limit like:

- `rate: { count: 10, periodMs: 60_000 }`

the observable contract is:

- blocked acquires receive an `acquireAt` time through `lock_created`
- a workflow retries `lock_acquired` only once that `acquireAt` has arrived, or
  sooner if it is explicitly re-queued with lock pre-approval
- a historical `lock_acquired` is only valid while its lease is still live
- once the lease has expired, replay must ignore that old acquisition and
  acquire again

The important distinction in the event log is:

- `lock_created`: reservation / retry scheduling information
- `lock_acquired`: proof that a live lease was actually granted
- `lock_release`: disposal of the granted lease, optionally with a nominated
  next waiter to wake

### 5. Use one `lock()` API from workflow scope

We want one user-facing primitive:

```ts
await using lease = await lock({ ... });
```

`lock()` means workflow code acquires ownership of a keyed lease.

If placed at the top of a workflow, it should hold the lease across the logical
workflow scope, even though the workflow may suspend and resume many times.

Steps themselves do not acquire locks directly. To limit one step category or a
group of steps, the workflow acquires the lock and then calls those steps while
the lease is held.

### 6. `await using` is the preferred user-facing shape

The preferred API is explicit resource management:

```ts
await using lease = await lock({ ... });
```

This gives automatic cleanup on scope exit and reads well for critical sections
that may include one or many step calls.

For manual early cleanup, the user-facing `LockHandle` should expose:

- `dispose()`
- `[Symbol.asyncDispose]()`

The backend-facing world contract can continue to use `release(...)` internally.

### 7. Locks follow logical scope, not request lifetime

For workflows, `await using` must be tied to the logical workflow scope across:

- step round trips
- queue turns
- sleeps
- hooks
- replay/resume

The lease must not be disposed merely because one host process invocation ends.

### 8. Keep admission decisions in workflow code

Current preferred model:

- workflow code acquires and releases limits
- steps execute inside whatever critical section the workflow establishes
- step code never waits on a separate lock of its own

This keeps the dependency direction simple:

- workflow admission / critical section -> step execution

That avoids needing separate workflow-lock and step-lock runtime semantics.

### 9. Waiters are FIFO per key

Implemented worlds use a waiter queue and promote waiters in FIFO order for a
single limit key.

Important details:

- FIFO is per key, not global across all limit keys
- promotion order is based on waiter creation order
- terminal holders are pruned before capacity decisions
- dead or terminal waiters are pruned before promotion
- a live waiter may still be skipped if it is no longer eligible when promotion runs
- releasing a lease or reclaiming an expired lease can both trigger promotion
- rate-window expiry can also make the head waiter eligible again

Implemented worlds currently reclaim terminal holders opportunistically when a
key is touched, so completed, failed, or cancelled workflows do not hold
concurrency capacity until lease TTL expiry.

This gives deterministic and inspectable fairness for a key without requiring a
global scheduler.

### 9.5. First writer wins for key configuration

Each limit key has one canonical definition while it is live.

- the first acquire for a key seeds that definition
- later acquires for the same key must match it exactly
- a mismatched definition is a hard error
- once a key fully drains, the canonical definition is forgotten and the next
  acquire may seed a new one

### 10. Blocked limits do not consume worker concurrency

Blocked flow limits and worker concurrency are intentionally separate.

For implemented worlds:

- blocked workflows are suspended and re-queued, not left running on a worker
- worker slots are free to service unrelated work while the blocked execution is
  waiting to be retried or promoted

PostgreSQL additionally keeps that backlog durable in the database. The local
world keeps queue delivery in-memory, so cross-process crash recovery for the
backlog is explicitly outside the shared limits contract today.

### 11. Wake-up is prompt, with a delayed fallback

Implemented worlds use the world-owned limit state as the source of truth and
try to resume promoted waiters promptly, with a delayed fallback still in place
so progress is possible if an immediate wake-up is missed.

Current behavior:

- leases, rate tokens, and waiters live in world-owned limit state
- promotion decisions are made from that limit state
- `lock_release` may nominate the next waiter to wake
- event storage is responsible for enqueuing that waiter with lock pre-approval
  and then appending `lock_waiter_queued` for the waiter correlation
- workflows also keep a delayed replay fallback so progress is still possible if
  an immediate wake-up is missed

PostgreSQL uses Graphile jobs for that wake-up path and keeps the backlog
durable across host/process failure. The local world uses an in-memory queue, so
prompt wake behavior matches while the process is alive, but durable backlog
survival is not guaranteed after process loss.

### 12. V1 semantics are intentionally opinionated

For v1, the intended semantics are:

- workflow locks count admitted, in-flight workflows for a key
- workflow-held keys may be used to serialize or rate-limit specific step categories
- worker concurrency remains a separate infrastructure throttle

More concretely:

- if a workflow acquires a lock and then sleeps for 10 minutes,
  it still counts as active for that workflow key during the sleep
- if a workflow acquires a lock for a step-like key such as `step:db:cheap`,
  that key remains occupied until the workflow releases it, even if the
  protected work is just one step call or a small group of step calls
- rate-limited step-like keys still consume rate capacity when the workflow
  acquires that key, and that usage remains counted until the window expires
  even if the workflow releases the lease quickly

For the current local implementation specifically:

- workflow locks now follow the same live-process waiter/fairness semantics as
  Postgres
- the queue remains in-memory, so queued wake-ups are not durable across process
  loss

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
  return { userId, prompt: `profile:${userId}` };
}

async function expensiveAIStep(prompt: string) {
  'use step';
  return `summary:${prompt}`;
}

export async function workflowWithScopedLocks(userId: string) {
  'use workflow';
  await using userLimit = await lock({
    key: `workflow:user:${userId}`,
    concurrency: { max: 2 },
  });

  let row: Awaited<ReturnType<typeof cheapDbStep>>;
  {
    await using _dbLimit = await lock({
      key: 'step:db:cheap',
      concurrency: { max: 20 },
    });
    row = await cheapDbStep(userId);
  }

  let summary: Awaited<ReturnType<typeof expensiveAIStep>>;
  {
    await using _aiLimit = await lock({
      key: 'step:provider:openai',
      rate: { count: 10, periodMs: 60_000 },
    });
    summary = await expensiveAIStep(row.prompt);
  }
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

Two more practical clarifications:

- a blocked workflow lock should not monopolize
  `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` or
  `WORKFLOW_LOCAL_QUEUE_CONCURRENCY` just because it is waiting
- a released lease may nominate one waiter for prompt wake-up, but delayed retry
  remains in place as the fallback path

## Open Questions

- Whether workflow-level locks should always be whole-run admission locks or
  also support narrower lexical scopes within workflow code.
- Whether `heartbeat()` should remain user-visible or become mostly internal.
- Whether `lock()` should eventually grow optional metadata or
  config sugar for common per-step resource keys.
