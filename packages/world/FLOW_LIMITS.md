# Flow Limits

This document describes the current flow-limits contract for `@workflow/core`,
`@workflow/world`, and the implemented worlds.

## Status

- `lock()` exists in workflow scope.
- `@workflow/world-local` implements the shared flow-limits contract.
- `@workflow/world-postgres` implements the same contract with durable state.
- `@workflow/world-vercel` still exposes a stub.
- The E2E workbench covers workflow locks, step-like scoped locks, FIFO waiters,
  terminal holder recovery, and rate limits.

## Shared Contract

### Limit definitions

Each key has one live definition:

- concurrency only
- rate only
- concurrency and rate

The first acquire for a key seeds that definition. Later acquires for the same
live key must match it exactly. Once the key fully drains, the definition is
forgotten and the next acquire may seed a new one.

### What `lock()` means

Workflow code acquires and releases locks.

```ts
await using lease = await lock({
  key: `workflow:user:${userId}`,
  concurrency: { max: 1 },
});
```

The lease follows workflow scope, not host process lifetime. If the workflow
suspends and resumes later, the lease is still considered held until the scope
ends, the lease expires, or the holder becomes terminal and is reclaimed.

Steps do not acquire locks directly. The workflow acquires a lease, then calls
steps while the lease is held.

### Acquire outcomes

`limits.acquire()` has only two outcomes:

- `acquired`
- `blocked`

Blocked acquires report one of these reasons:

- `concurrency`
- `rate`
- `concurrency_and_rate`
- `queued`

`queued` means the request is live, but another waiter is ahead of it for the
same key.

### Lease lifetime

- A live lease occupies concurrency capacity for its key.
- A consumed rate token occupies rate capacity until its window expires.
- Releasing a lease frees concurrency capacity immediately.
- Releasing a rate-only lease does not refund the rate window.
- `heartbeat()` extends a live lease.
- Heartbeating a missing or expired lease fails with `WorkflowWorldError`.

### Holder reuse

If the same holder replays an acquire for the same key while it already owns the
live lease, the world must return that same lease instead of creating another
lease or waiter.

If the same holder replays a blocked acquire, the world must keep a single
waiter entry for that holder.

### Waiters

Waiters are FIFO per key.

For a single key:

- the oldest eligible waiter is first
- live waiters behind the head remain blocked with reason `queued`
- terminal waiters are skipped
- terminal holders are reclaimed before capacity decisions

Blocked workflows do not consume worker concurrency while waiting.

### Wake-up model

Wake-up is prompt, with delayed fallback.

The shared behavior is:

1. The world promotes waiters from world-owned limit state.
2. `lock_release` may include the promoted waiters.
3. Event storage enqueues promoted waiters and records `lock_waiter_queued`.
4. Workflows still keep delayed replay fallback in case a prompt wake-up is
   missed.

### Event model

The lock event lifecycle is:

- `lock_created`: the workflow asked for a lock
- `lock_acquired`: a live lease was granted
- `lock_release`: the granted lease was released
- `lock_waiter_queued`: a promoted waiter was explicitly re-queued

For rate waits:

- `lock_created` may carry `acquireAt`
- replay must not trust an old `lock_acquired` once its lease is no longer live

## Backend Notes

### Local world

- Limit state lives on disk.
- Prompt wake-up uses the in-memory local queue.
- FIFO, waiter promotion, terminal holder pruning, and rate semantics should
  match Postgres while the process is alive.
- Durable backlog survival across process loss is not part of the current local
  contract.

### Postgres world

- Limit state is stored in PostgreSQL.
- Prompt wake-up uses the Postgres-backed queue path.
- Waiters, leases, and rate tokens are durable.
- Prompt wake-up survives normal host or process churn because the backlog is
  stored durably.

### Vercel world

- `limits` is still a stub.
- No flow-limits behavior is promised there yet.

## Example Keys

The current examples use keys like:

- `workflow:user:${userId}`
- `step:db:cheap`
- `step:provider:openai`

That gives one simple model:

- workflow keys gate admitted workflows for a business key
- step-like keys are still held by workflow scope
- worker concurrency stays separate from flow limits

## Non-Goals

Flow limits are not worker throughput settings.

These remain separate concerns:

- worker concurrency
- queue throughput
- workflow admission for a business key
- rate limiting for a business key

## Open Questions

- Whether `heartbeat()` should stay user-visible or become mostly internal.
- Whether `lock()` should gain any sugar beyond the current explicit key +
  definition shape.
