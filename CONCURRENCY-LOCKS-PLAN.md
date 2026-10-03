# Native concurrency (`lock`) — implementation plan for a first version

Status: PROPOSAL. Nothing here is implemented. Scopes and sequences the `lock`
primitive from [RFC #301](https://github.com/vercel/workflow/discussions/301),
specifically the [WIP Lock Implementation
Spec](https://github.com/vercel/workflow/discussions/301#discussioncomment-16214309).

The RFC spec covers two primitives: a **distributed semaphore** and a **rate
limiter**. This plan ships only the semaphore, and ships it in two stages. §8
says why, and what the rate limiter inherits when it lands.

Terminology used throughout: a *slot* is one unit of a key's concurrency; a
*holder* is a run occupying one; a *waiter* is a run suspended until one frees.

---

## 0. The invariant that makes everything safe

**A slot is granted by exactly one atomic conditional write, and that write is
the only correctness fence.** Every other mechanism below — the waitlist, the
handoff, the lease, the backstop poll, the terminal reclaim — is a *liveness*
or *latency* mechanism. Each of them may fire twice, fire late, or not fire at
all, and the system must still never admit more than `concurrency` holders.

Concretely, in every World: "read the counter, decide, write the counter" is
forbidden. The grant is `count < concurrency ? count += 1 : reject`, evaluated
and committed in one conditional update (DynamoDB `UpdateItem` with
`ConditionExpression`, Postgres `UPDATE … WHERE count < concurrency
RETURNING`, a single Lua script, an fs-level exclusive create). This is the
property to defend in review of every World implementation, and the one the
TLA+ model in §7 exists to pin.

The corollary is that every tuning decision below — lease TTL, poll interval,
grant grace, backoff — is an economics decision about how long a slot can sit
idle or how long a waiter waits. None of them can over-admit.

---

## 1. User-facing API

```ts
import { lock } from 'workflow';

async function chargeCustomer(customerId: string) {
  'use workflow';

  // Suspends the run until one of 5 slots for this key is free.
  // Releases on scope exit.
  await using slot = await lock(`stripe:${customerId}`, { concurrency: 5 });

  await charge(customerId);
}
```

**Correction to the RFC snippet.** The RFC writes `await using lock("key", {
concurrency: 30 })`. That is not valid JS: `await using` requires a binding,
and — more importantly — `await using x = expr` does **not** await `expr`. It
awaits only the disposal at scope exit. So acquisition needs its own `await`:

```ts
await using slot = await lock(key, opts);
//                 ^^^^^ acquires (suspends the run)
// ^^^^^^^^^^^ releases at scope exit
```

`lock()` returns `Promise<LockSlot>`. `LockSlot` implements `[Symbol.dispose]`,
`[Symbol.asyncDispose]`, and an explicit `release()`. All three do the same
thing in v1 (queue a `lock_released`, flushed at the next suspension, exactly
as `hook_disposed` is today), so `using slot = await lock(...)` also works.
`await using` is what the docs will show: it is what the RFC promised, and it
is the form that stays correct if release ever becomes genuinely async.

Options for v1:

| option | type | default | notes |
|---|---|---|---|
| `concurrency` | `number` | required | integer ≥ 1. First writer for a key wins; see §6.3 |
| `leaseTtlMs` | `number` | 24h | backstop only; see §6.2 |

Deliberately **not** in v1: `timeout` / `signal` on acquisition, priority,
`rate`, `skip`/`restart` conflict behavior for singleton jobs. §8.

Scope rules, matching the RFC: **run-level only.** `lock()` is available in
`"use workflow"` functions and throws `throwNotInWorkflowContext` from a step,
the same as `sleep()`. To gate a step, wrap the call site:

```ts
{
  await using slot = await lock('provider:acme', { concurrency: 10 });
  await callProvider(); // "use step"
}
```

---

## 2. Event model (spec version 8)

Four new event types in `packages/world/src/events.ts`, all sharing one
`correlationId` per lock scope:

| event | writer | payload |
|---|---|---|
| `lock_created` | runtime | `{ key, concurrency, leaseTtlMs? }`, answered with `retryAt?` |
| `lock_acquired` | **World** | `{ key, leaseExpiresAt }` |
| `lock_released` | runtime | `{ key }`, answered with `grantedTo?: { runId, correlationId }` |
| `lock_waiter_queued` | runtime | `{ key, runId, correlationId }` (stage 2 only) |

Naming note: the RFC says `lock_release`. Every event type in this log is past
tense (`hook_disposed`, `wait_completed`, `step_completed`), so `lock_released`.

`lock_acquired` is **World-origin**, following the `hook_conflict` precedent:
the runtime POSTs `lock_created` and the World may answer with a
`lock_acquired` event *instead*, committed atomically with the counter
increment. There is no separate round trip for the uncontended grant, which is
the case that has to be fast.

### 2.1 Correlation ids — deviation from the RFC

The RFC proposes keying idempotency on `run ID + lock key + relative index of
the lock in the event loop` (`-0`, `-1` suffixes). This repo already has that
property for free: `ctx.generateUlid()` is seeded per run and replay-stable, so
`lock_${ctx.generateUlid()}` is positional, unique per lock scope, and
identical on every replay — the same thing `sleep()` does with
`wait_${ctx.generateUlid()}`. It also plugs straight into slot identity and the
existing duplicate-event machinery.

So: **correlationId = `lock_<ulid>`**, key travels in `eventData`. Two gates on
the same key in one run get different correlation ids naturally.

### 2.2 Replay determinism

`key` and `concurrency` are computed by user code, so they must be
replay-stable. On replay, if the recomputed `key`/`concurrency` differ from
what `lock_created` recorded, raise `ReplayDivergenceError` — the same check
`workflow/sleep.ts` performs on `resumeAt`.

### 2.3 Plumbing the new types

- `packages/world/src/events.ts` — `EventTypeSchema`, per-event Zod schemas, a
  `LockEventType` group + `isLockEventType`.
- `packages/world/src/event-metadata.ts` — one `ENTITY_EVENT_CLASS_BY_TYPE`
  entry per type (each resolves once per correlation id).
- `packages/core/src/events-consumer.ts` — add `lock_acquired` to the parkable
  allowlist. It is World-origin and can reach the head of the walk before this
  replay has installed its consumer, which is exactly what parking is for.
  `lock_created` / `lock_released` / `lock_waiter_queued` are replay-origin and
  stay strict.
- `packages/world/src/spec-version.ts` — `SPEC_VERSION_SUPPORTS_LOCKS = 8`,
  bump `SPEC_VERSION_CURRENT` / `SPEC_VERSION_MAX_SUPPORTED`.
- `packages/world/src/interfaces.ts` — `WorldCapabilities.locks?: {
  concurrency: boolean }`. **Fail closed**: `lock()` throws
  `LockUnsupportedError` when the World does not declare it, so a run can never
  silently execute unbounded.
- `packages/world/src/locks.ts` — new `LockSchema` / `LockWaiterSchema`
  entities, mirroring `waits.ts`.
- `packages/errors/src` — `LockUnsupportedError`, plus an error code.

---

## 3. Stage 1 — counter and backstop poll

Ships the API, the event log, and the safety property. Not FIFO; see §3.4.

### 3.1 World state

Per `(tenant, key)`:

```
lock       { key, concurrency, count, updatedAt }
lockHolder { key, runId, correlationId, leaseExpiresAt }   // one row per slot held
```

`count` is authoritative for admission; holder rows exist so a slot can be
attributed, reclaimed on terminal runs, and surfaced in o11y.

### 3.2 Grant path

On `lock_created`:

1. Upsert the `lock` row if absent (`concurrency` from the event).
2. Prune holder rows whose `leaseExpiresAt` has passed, decrementing `count`.
3. One conditional write: `count += 1 IF count < concurrency`.
   - won → insert the holder row, commit `lock_acquired` with
     `leaseExpiresAt = now + leaseTtlMs`, return it *in place of*
     `lock_created`.
   - lost → commit `lock_created` with `retryAt`.

Idempotency: a re-POST for an existing `(runId, correlationId)` that already
holds a slot returns the committed `lock_acquired`; one that is still pending
returns the committed `lock_created` with a fresh `retryAt`. No double
increment.

### 3.3 Runtime path

Mirrors `sleep` end to end, which is the point — the machinery already exists:

| concern | `sleep` today | `lock` |
|---|---|---|
| VM primitive (node) | `workflow/sleep.ts` `createSleep(ctx)` | new `workflow/lock.ts` `createLock(ctx)` |
| VM primitive (quickjs) | `VM_BOOTSTRAP` `WORKFLOW_SLEEP` | `WORKFLOW_LOCK`, `__pending` item `type: "lock"` |
| global symbol | `WORKFLOW_SLEEP` | `WORKFLOW_LOCK` (`symbols.ts`, wired in `workflow.ts`) |
| queue item | `WaitInvocationQueueItem` | `LockInvocationQueueItem` (`global.ts`) |
| event write | `wait_created` in `suspension-handler.ts` | `lock_created` / `lock_released` / `lock_waiter_queued` |
| delayed wake | `waitTimeout` → `getWaitContinuationDispatch` | `lockRetry` → `getLockContinuationDispatch` |
| ordering | `registerDeliveryBarrier(ctx, i, 'wait')` | same, kind `'lock'` |

Two things deserve more than a table row:

**The continuation.** `runtime/wait-continuation.ts` already solves the hard
part of delayed self-re-enqueue: hop chaining past the queue's 23h visibility
limit, and the attempt-suffixed idempotency key that keeps an early delivery
from burning the key and stranding the run forever. Generalize it to
`runtime/continuation-dispatch.ts` parameterized by a prefix, and give locks
`lockRetry?: { seconds, correlationId }` next to `waitTimeout` on
`SuspensionHandlerResult`, plus `lockContinuation` on
`WorkflowInvokePayloadSchema` (with the same `.catch(undefined)` guard every
optional payload field has). A run with both a pending wait and a pending lock
arms whichever fires first; the other is re-observed on the next pass.

**Ordering.** `lock_acquired` is branch-deciding: a workflow can
`Promise.race` it against a hook payload or a step result. It must therefore
register a delivery barrier at its event index and defer behind earlier
hook/step/wait deliveries before resolving, exactly as `wait_completed` does in
`workflow/sleep.ts`. Same detached-promise shape, same reasoning about the
serial `promiseQueue`.

### 3.4 What stage 1 does not give you

**FIFO, and therefore freedom from starvation.** Every waiter polls; the
winner of each free slot is whoever polls next. Under heavy contention a
specific run can wait a long time. This is stated in the docs banner for the
stage-1 release and is the entire motivation for stage 2.

The backoff policy is World-computed (returned as `retryAt`), so it can improve
without an SDK release. Reference policy: exponential with full jitter, base
1s, cap 30s.

### 3.5 Terminal reclaim

The RFC leaves a failed or cancelled holder's slot pinned until the lease
expires — 24h by default, for what is an ordinary occurrence. Close it in v1:
when a World materializes `run_completed` / `run_failed` / `run_cancelled`, it
deletes that run's holder rows and decrements `count`. The lease stays as the
backstop for the case a terminal event is never written at all (host loss).

---

## 4. Stage 2 — FIFO waitlist and direct handoff

Purely additive: same API, same event types, same World tables plus one. What
changes is that a freed slot is *handed* to the head of a queue instead of
raced for, so `retryAt` demotes from the hot path to a rarely-used backstop
(default 5 min instead of ~1s) and admission becomes FIFO.

### 4.1 World state

```
lockWaiter { key, seq, runId, correlationId, grantedAt? }
```

`seq` from an atomic per-key counter. The waitlist is ordered by `seq`.

### 4.2 Protocol

- `lock_created` with `count >= concurrency` **or a non-empty waitlist** →
  append a waiter row (idempotent on `(key, runId, correlationId)`), return
  `lock_created` with the long backstop `retryAt`. Admitting past a non-empty
  waitlist is what would break FIFO, so the emptiness check is part of the
  conditional write, not a separate read.
- `lock_released` → delete the holder row, `count -= 1`, then peek the head
  waiter, skipping rows whose run is already terminal (deleting those as it
  goes). If there is one, stamp `grantedAt = now` and return
  `grantedTo: { runId, correlationId }` on the event.
- Runtime, consuming a `lock_released` that carries `grantedTo`: publish a
  workflow message to that run (idempotency key
  `lock:<key>:<granteeCorrelationId>`), then POST `lock_waiter_queued`. **The
  run may not write its terminal event until `lock_waiter_queued` is in its
  log**, so a redelivery re-drives the handoff. This is the RFC's design and
  it is right: it keeps queue publishing out of the World's event-write path
  and makes the handoff crash-safe against the queue's own retry contract.
- The woken run replays, reaches `lock()`, re-POSTs `lock_created`, and the
  World grants it because it is the head of the waitlist.

### 4.3 Two things the RFC glosses over

**`lockPreApproval` is a hint, not an authorization.** The RFC has the queue
message carry `lockPreApproval: <key>` and the World grant on that basis. Don't
trust a queue message for an admission decision: the World already knows who
the head of the waitlist is. Carry
`lockPreApproval?: { key, correlationId }` on `WorkflowInvokePayload` for the
idempotency key and for tracing, and let head-of-line position decide the
grant. Same outcome, one less thing that can forge a slot.

**A grant can be dropped.** If the woken run never comes back — it crashed, its
message was lost, it was cancelled between the pop and the wake — the head
waiter sits `grantedAt` forever and the slot is reserved but unheld. So: any
`lock_created` or `lock_released` touching the key first checks whether the
head's `grantedAt` is older than `grantGraceMs` (default 60s) and, if so,
re-grants — either re-waking the same waiter or, if its run is terminal,
dropping it and moving on. The waiter's own backstop `retryAt` re-POST reaches
the same state from the other side. Belt and braces, because a lost grant is
the one failure here that is a permanent stall rather than a slow path.

---

## 5. Where the code goes

### `vercel/workflow`

| area | files |
|---|---|
| public API | `packages/core/src/lock.ts` (global-symbol stub, mirrors `sleep.ts`), `packages/core/src/workflow/index.ts`, `packages/workflow/src/*` re-exports |
| node VM | `packages/core/src/workflow/lock.ts`, `packages/core/src/symbols.ts`, `packages/core/src/workflow.ts` (`vmGlobalThis[WORKFLOW_LOCK]`) |
| quickjs VM | `packages/core/src/runtime/quickjs-runtime.ts` (`VM_BOOTSTRAP`), `packages/core/src/runtime/quickjs-entrypoint.ts` (feed + continuation arming, alongside the elapsed-wait pass) |
| suspension | `packages/core/src/global.ts`, `packages/core/src/runtime/suspension-handler.ts`, `packages/core/src/runtime.ts` (node engine dispatch, next to `waitTimeout`) |
| continuation | `packages/core/src/runtime/wait-continuation.ts` → generalized `continuation-dispatch.ts` |
| contract | `packages/world/src/{events,event-metadata,interfaces,spec-version,locks,queue}.ts` |
| worlds | `packages/world-local/src/fs.ts`, `packages/world-postgres/src/{storage.ts,drizzle/schema.ts,drizzle/migrations}`, `packages/world-vercel` (capability + passthrough) |
| testing | `packages/world-testing/src/locks.mts`, `packages/world-sim/src/{store.ts,invariants.ts}`, `workbench/sim-world` scenarios |
| o11y | `packages/web-shared/src/lib/{event-analysis,event-materialization,duplicate-events}.ts`, `components/sidebar/entity-detail-panel.tsx`, `components/workflow-traces/trace-span-construction.ts` |
| docs | `docs/content/docs/v5/api-reference/workflow/lock.mdx`, a `foundations/concurrency.mdx` guide, `worlds-manifest.json` feature flags per world |

### `vercel/workflow-server`

| area | files |
|---|---|
| schema | `lib/schemas.ts`, `lib/version-utils.ts` (spec 8) |
| storage | `lib/data/electrodb.ts` — `workflow_lock`, `workflow_lock_holder`, `workflow_lock_waiter` entities |
| materialization | `lib/data/events.ts`, `lib/handlers/events.ts` (reject client-submitted `lock_acquired`, the same way `noop` is server-origin-only) |
| region | reuse the `hook_token_constraint` home-region pin (§6.1) |
| model | `specs/LockLifecycle.tla` + cfgs (§7) |

The lock rows are the **first cross-run entity in the system** other than the
hook-token constraint. Every existing entity is keyed under a run. That is the
single biggest structural fact about this feature and the reason the
`hook_token_constraint` precedent is worth following closely: it is already a
tenant-scoped, globally-unique, single-home-region, conditionally-written item.

---

## 6. Risks and the decisions taken

### 6.1 Hot partitions and cross-region latency

Every acquisition and release is a conditional write to one item keyed by lock
key. In DynamoDB that is a single partition: roughly 1k WCU/s. A key doing
more than ~500 acquire/release pairs per second will throttle.

Accepted for v1, documented as the throughput ceiling. Two later outs, neither
of which changes the event log: shard the counter into N sub-counters with
`concurrency` split across them (trades exact FIFO for throughput), or put a
Redis Lua script in front (`lib/redis-script.ts` is the precedent) with
DynamoDB as the durable source of truth.

Region: lock rows pin to one home region, like hook-token constraints, because
a key must be globally unique across regions. Out-of-region runs pay ~60–80ms
per acquire. Accepted; it is what the hook path already pays.

### 6.2 Over-admission after lease expiry

The RFC notes that a holder running longer than `leaseTtlMs` will "keep
re-acquiring locks in a loop", and suggests a replay keep-alive. v1 does
neither: lease expiry frees the slot on the World side, and the holder is not
told. Briefly, `concurrency + 1` runs can be in the critical section.

This is deliberate. The default lease is 24h, terminal reclaim (§3.5) handles
every ordinary failure, and the keep-alive requires either duplicate
`lock_acquired` events in the log (which fights `entityEventClass`) or a new
side channel. Both are worse than a documented 24h bound. Revisit with the
keep-alive if telemetry shows real holders near the lease.

### 6.3 Conflicting `concurrency` for one key

RFC: first writer wins, warn, immutable until the counter reaches 0. Keep that
— *and* add a `world.locks.setConcurrency(key, n)` admin path, because
"immutable until the counter hits 0" means an operator cannot raise a limit
during the incident where they need to. The steady-state grant path stays a
single conditional write; the re-read only happens on the admin call.

### 6.4 Liveness coupling

In stage 2 a releasing run cannot finish until it has woken its successor. A
run's own completion now depends on a queue publish for another run. The
backstop poll is what makes this a latency problem rather than a deadlock, and
it is the reason the backstop is not removed once handoff works.

### 6.5 Deadlock across keys

Two keys acquired in opposite orders by two workflows deadlock, and nothing
here detects it. v1: document it, log a warning when a run holds ≥ 2 locks,
and surface held locks per run in o11y so it is diagnosable. A wait-for-graph
cycle detector is a plausible v2 given the World already has the full waitlist.

### 6.6 Unbounded waitlists

A million runs behind `concurrency: 1` is a million rows and a million backstop
messages. v1 adds a World-configured cap with a clear error, defaulted high
enough not to bite (open question: what number, and whether the default is
"unbounded").

---

## 7. Testing

The safety property is about interleavings, so the testing weight goes there,
not into unit tests of the happy path.

- **Conformance** — `packages/world-testing/src/locks.mts`, the contract every
  World must pass: never over-admit under concurrent acquires; idempotent
  re-POST; release frees exactly one slot; terminal reclaim; lease expiry;
  (stage 2) FIFO order, handoff, grant grace, cancelled waiter skipped.
- **Deterministic simulation** — `world-sim` scenarios for: two runs racing the
  last slot, release racing a fresh acquire, a lost handoff, a run cancelled
  while waitlisted, a duplicate `lock_created` delivery, a replay that observes
  `lock_acquired` before installing its consumer. Plus an `invariants.ts`
  check re-derived from the log alone: at no position does the set of runs
  holding a key exceed its concurrency.
- **TLA+** — `workflow-server/specs/LockLifecycle.tla` is not optional. That
  repo's AGENTS.md requires a model for subsystems with concurrent writers and
  partially-applied retries, and this is the archetype. Ship with a
  counterfactual `NoAtomicGrant.cfg` (read-then-write reproduces
  over-admission) and a `GrantGrace.cfg` / `NoGrantGrace.cfg` pair for the
  dropped-grant stall, so the suite fails as loudly when the guarantee
  silently returns as when it silently breaks.
- **E2E** — a `workbench/nextjs-turbopack` workflow that fans out N runs
  against `concurrency: 2` and asserts maximum observed overlap, run on
  world-local and world-vercel.

---

## 8. Explicitly out of scope for v1

**Rate limiting.** The RFC marks its own rate-limit design 🚧 and says it will
move to ring buffers to get at-most and at-least guarantees; shipping the
current sketch would bake a known-wrong storage layout into the event log. It
also needs almost nothing new once stage 1 lands: `acquireAt` is stage 1's
`retryAt`, and the continuation chaining is already shared. The addition is one
option shape — `lock(key, { rate: { count, periodMs } })` — and a World-side
ring buffer behind the same four events.

**Acquisition timeouts / `AbortSignal`.** Wanted, straightforward on top of the
backstop wake (compare `now` against an `expiresAt` recorded on
`lock_created`), but needs a fifth event for the failure outcome. Reserve
`expiresAt` in the `lock_created` schema now so it is additive later.

**Priority queueing, singleton `skip`/`restart` semantics** (eluce2's ask in
the thread), **`useStep`-style per-invocation overrides**, **`maxConcurrency`
declared on a step or workflow function.** All of these are the "syntactic
sugar on top of the lock primitive" the RFC describes, and all are cheaper to
design once the primitive is real.

---

## 9. Sequencing

Each row is one PR. 1–5 are SDK-only and can land while the server work is in
flight; 6 is the long pole.

| # | scope | depends on |
|---|---|---|
| 1 | `@workflow/world`: event schemas, spec 8, capability, `Lock` entities. No behavior. | — |
| 2 | Core runtime + node VM + suspension handler + continuation; `world-local` stage 1. | 1 |
| 3 | QuickJS VM parity. | 2 |
| 4 | `world-postgres` stage 1 + migration. | 1 |
| 5 | `world-testing` conformance + `world-sim` scenarios and invariant. | 2, 4 |
| 6 | `workflow-server` stage 1 (entities, materialization, TLA+ model) + `world-vercel` capability. | 1 |
| 7 | Stage 2 (waitlist, handoff, grant grace) across contract, core, all worlds, server, model. | 5, 6 |
| 8 | Observability, docs, workbench example, changeset. | 7 |

A usable beta exists after 6: `lock()` works everywhere, never over-admits, and
is honest in its docs about not being FIFO. That is the thing to put in front
of the people in the RFC thread who are choosing between this and Temporal,
because it is the one capability they said they cannot ship without — and
unlike a Redis semaphore inside a step, a run waiting on it is suspended and
costs nothing while it waits.
