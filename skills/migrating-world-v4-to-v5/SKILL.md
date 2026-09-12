---
name: migrating-world-v4-to-v5
description: >-
  Upgrades a custom Workflow SDK World implementation from the v4 spec to v5. Use when a package implements the `World` interface from `@workflow/world` and is moving to 5.x — event IDs that are ULIDs rather than slot positions, `Event id is not slot-numbered` at replay time, a `specVersion` the runtime refuses, `writeToStream` / `closeStream` / `readFromStream` as top-level World methods, `steps.get` or `events.listByCorrelationId` without a `runId`, a `'step'` queue kind or `__wkf_step_*` topics, a `preconditionGuard` capability, or a `createLocalWorld` / `createVercelWorld` factory.
metadata:
  author: Vercel Inc.
  version: '0.3.1'
---

# Migrating a World from the v4 spec to v5

This skill is for a package that implements `World` from `@workflow/world`: a storage, queue and stream backend the Workflow runtime talks to. It is not for application code. If the task is bumping an app's `workflow` dependency, use the `migrating-workflow-v4-to-v5` skill instead; if the app both uses Workflow and ships its own World, run that skill first and this one second.

An app on the Vercel, Local or Postgres World needs nothing from this skill. Those ship with the SDK and are already on the v5 spec.

One change dominates the work. **Event ID allocation is required, is not visible from the type signatures, and a World that skips it type-checks, starts runs, and fails on the first replay.** Do that part first, then the mechanical rewrites. Do not begin with the type errors: they are the small half, and finishing them produces a World that looks migrated and is not.

## Intake

Before editing, establish and report each of these:

1. **Where the World is.** Grep for `implements World`, `: World`, `World>` and `from '@workflow/world'`. Read the factory it exports.
2. **How event IDs are minted today.** Grep for `eventId`, `ulid`, `uuid`, `nanoid`, `nextval`, `AUTO_INCREMENT`, `IDENTITY`. Find the exact line that produces the ID written to storage.
3. **What settles a write race.** Read the `events.create` implementation. Note whether the ID or ordering is decided in process (read-then-write, an in-memory counter, a `Math.max` over loaded events) or in the store (unique constraint, conditional write, `INSERT ... ON CONFLICT`, a transaction).
4. **Which `specVersion` it declares.** Grep for `specVersion`. Note whether it is a literal or an imported constant.
5. **Which optional members exist.** Grep for `capabilities`, `analytics`, `getRuntimeDeadline`, `getEnvironment`, `createRunId`, `describeRun`, `getEncryptionKeyForRun`, `resolveLatestDeploymentId`, `cancelMany`, `experimentalSetAttributes`.
6. **Whether it provisions step topics.** Grep for `'step'`, `__wkf_step`, `stepQueue`.
7. **Whether it rejects stale writes.** Grep for `PreconditionFailedError`, `preconditionGuard`, `stateUpdatedAt`, `stateEventCount`, `stateCursor`, `412`.
8. **Where its process-wide state lives.** Grep the World's modules for top-level `const`/`let` holding a pool, client, socket, registry, cache, ULID factory, or a log-once boolean. Note every one: these are correct in a `require()`d package and wrong in a bundled one.
9. **How it is tested.** Grep for `@workflow/world-testing` and `createTestSuite`. A World without the conformance suite wired up gets it in this migration.
10. **Where its runs live.** Ask, or determine from the deployment model, whether a single deployment serves every run or a run is pinned to the deployment that created it. This decides the rollout in step 7 and cannot be read out of the code.

Report anything not applicable rather than skipping it silently.

## Step 1 — event ID allocation

In v4 an event ID was a ULID the World minted however it liked. In v5 an event ID is the event's **position in its run's log**: `evnt_` followed by a 1-based slot, zero-padded to 26 characters, so a run's first event is `evnt_00000000000000000000000001`.

```ts
import { slotToEventId, eventIdToSlot, FIRST_EVENT_SLOT } from '@workflow/world';

slotToEventId(1); // 'evnt_00000000000000000000000001'
eventIdToSlot('evnt_00000000000000000000000042'); // 42
eventIdToSlot('evnt_01JQ...'); // null
```

Format IDs with `slotToEventId()`. Do not hand-roll the padding. The fixed width is what makes lexicographic order the same as positional order, so a World padding to a different width sorts its own log wrongly past ten events.

There is no capability to declare and no fallback path. The runtime calls `requireEventSlot()` on IDs it loads, which throws `Event id is not slot-numbered: <id>. This World allocates event positions the runtime cannot read.`

Four rules bind the implementation. Check each against the code found in intake items 2 and 3:

- **Uniqueness.** Two concurrent appends must not both take a slot. Settle it where the store settles it: a unique constraint on `(runId, eventId)`, a conditional write, or a serializable transaction. Reading the maximum slot and adding one in process is the failure mode this rule exists for, and it survives light testing because it only breaks under concurrency.
- **Density.** Slots run from 1 with no holes. A writer that loses a race re-derives its slot from the store and takes the next free one. Incrementing a local number after a loss leaves a permanent hole, and the runtime fails the run with `CORRUPTED_EVENT_LOG` rather than replay across one.
- **Bump and report.** `events.create()` params carry `eventCount`: how many events the writer held in the log it replayed from, so the slot it expects is `eventCount + 1`. When that slot is taken, **do not reject the write.** Commit at the next free slot, and return the events occupying the slots you skipped on the success response, in `events` with a matching `cursor` and `hasMore`. A stale count is the normal case for a parallel fan-out; rejecting it would serialize writes the runtime deliberately issues concurrently. A create that arrives with no `eventCount` came from a caller with no loaded log (a queued step body, an out-of-band writer) and is always accepted.
- **Allocate at the commit.** Take the slot in the same operation that appends the event, never earlier. This is what makes a reader's log a *prefix* of the run's log rather than a prefix with a hole in it: nothing can land behind a slot a reader has already passed. A World that hands out a slot in a request handler and commits later breaks the property every replay depends on.

The shape that satisfies all four, for a SQL store with a unique key on `(run_id, event_id)`, is to compute the ID *inside* the insert and let the constraint arbitrate:

```sql
INSERT INTO events (run_id, event_id, event_type, data)
SELECT $1,
       'evnt_' || lpad((coalesce(
         (SELECT cast(substring(prev.event_id from 6) AS bigint)
            FROM events prev WHERE prev.run_id = $1
           ORDER BY prev.event_id DESC LIMIT 1), 0) + 1)::text, 26, '0'),
       $2, $3
ON CONFLICT (run_id, event_id) DO NOTHING
RETURNING event_id;
```

No row returned means another writer took that slot. Retry the same statement: it re-reads the maximum from a store that has already advanced, which is the bump. `@workflow/world-postgres` does exactly this, with a bounded retry count and jittered backoff after the first few immediate attempts, and absorbs the conflict with `DO NOTHING` rather than raising, because these inserts run inside a transaction an error would poison.

The exact statement matters less than the property: the slot is computed and the row is inserted in one atomic operation against the rows the constraint protects, so a loser retries against the store rather than against a number it remembered. A store without conditional writes needs a serializable transaction instead, not an in-process lock, which only orders the writers inside one process.

Then return the skipped span whenever the committed slot exceeds `eventCount + 1`. Understating `eventCount` is safe and overstating is not: a count below the writer's true position only widens the reported span, which the writer discards where its log already holds the events; a count above it makes the World report less than the writer is missing, which is a hole the writer never learns about.

## Step 2 — declare the spec version

`specVersion` is the protocol version the World implements, and the number stamped on every run it creates. Call the helper rather than importing a constant:

```ts
import { mintedSpecVersion } from '@workflow/world';

export function createWorld(): World {
  return {
    specVersion: mintedSpecVersion(),
    // ...
  };
}
```

The runtime checks the declaration against a supported range before it creates or replays anything, and refuses a World outside it, naming both the range and what the World declared. The floor is the version that introduced slot-numbered IDs, because a World below it allocates IDs the runtime cannot read positions out of. The ceiling is the highest version the runtime can read.

`mintedSpecVersion()` is a function because the version a World stamps is a deployment choice: it answers with the sealed-log version by default, and one below it when `WORKFLOW_SEALED_LOG=0` opts new runs out. Both are inside the accepted range. Call it inside `createWorld()` rather than caching it at module load, so one process can create Worlds in both modes.

Report any of these as findings rather than leaving them:

- A hard-coded number. It leaves the World a version behind the next bump and gets it rejected by the runtime it ships alongside.
- `SPEC_VERSION_CURRENT` or `SPEC_VERSION_SUPPORTS_SLOT_IDENTITY` used as the declaration. Both are literals by another name here, since neither follows the sealed-log setting.
- Code that assumes every run matches what the World declares today. A run's version is persisted at creation and kept for life, so read it off the run.

### The sealed log and `noop`

The sealed-log version permits one alternative to allocating a position at the commit (step 1): hand positions out from a per-run counter *before* the commit, so concurrent writers never race for one, then restore density at read time by writing a `noop` event into any position provably abandoned. A `noop` occupies its position and means nothing — replay steps over it without delivering it and without advancing the deterministic clock.

For most migrations this is a no-op, and say so rather than skipping it: **a World that allocates at the commit is already compliant** and will never emit a `noop`, because no write can leave a position empty. Only build the sealing half if the World pre-assigns positions, and then it must also never return a page with an interior hole — return the dense prefix below the hole and let the next page pick up once the position resolves.

The half that always applies is the reader's: `noop` is not user-creatable, never sent to `events.create()`, and only the World's own read path may write one. If the World validates event types on read, make sure `noop` parses.

## Step 3 — apply the mechanical rewrites

These are signature and module-shape changes. Apply each only where the pattern appears.

### Streams moved to a `streams` namespace, with `runId` first

| v4 | v5 |
| --- | --- |
| `writeToStream(name, runId, chunk)` | `streams.write(runId, name, chunk)` |
| `writeToStreamMulti(name, runId, chunks)` | `streams.writeMulti(runId, name, chunks)` |
| `closeStream(name, runId)` | `streams.close(runId, name)` |
| `readFromStream(name, startIndex?)` | `streams.get(runId, name, startIndex?)` |
| `getStreamChunks(name, runId, options?)` | `streams.getChunks(runId, name, options?)` |
| `listStreamsByRunId(runId)` | `streams.list(runId)` |

The argument order flipped, so moving the methods without swapping arguments passes a stream name where a run ID is expected and type-checks whenever both are `string`. `readFromStream` had no `runId` at all; `streams.get` requires one, so thread the owning run through.

`streams.streamFlushIntervalMs` sets the flush window. The v5 default is `0`, so the first chunk flushes immediately. Set a value only to deliberately coalesce writes.

### `steps.get()` requires a `runId`

The first parameter was `string | undefined` and is now `string`. A World that looked a step up by ID alone needs the run in its key or its index.

### `events.listByCorrelationId()` requires a `runId`

A correlation ID identifies a step, hook or wait within its run, not across runs. Scope the lookup to one run. A World that paginates by event ID needs the run in its cursor comparison too, since two runs can now hold the same correlation ID. The same applies to `analytics.events.listByCorrelationId()`.

### Export a `createWorld()` factory

`createLocalWorld()` and `createVercelWorld()` are gone from the first-party packages, which now export `createWorld()`. Match that shape. The arguments are unchanged; this is a rename.

### Worlds are injected at build time

World selection is static, resolved into host bundles by the build rather than looked up dynamically at runtime. Verify the World still resolves after the upgrade and that its module graph survives bundling. A World that relied on a runtime `require` of a path computed from an environment variable will not be found.

## Step 4 — move process-wide state onto `globalThis`

This one is silent. It type-checks, it passes tests in isolation, and it fails only in a host that bundles the World.

A module's top-level `const` or `let` is one instance per *module instance*, not per process. Next.js compiles its server output into independent module graphs, and a bundled module is compiled into each with its own module-scope bindings. The runtime caches the *World object* process-wide, but module state that World closes over stays layer-local, so anything the World reaches at request time has to be process-wide too.

Take every finding from intake item 8 and hold it in one object:

```ts
import { globalSingleton } from '@workflow/utils';

const state = globalSingleton('@my-org/world-foo//connections', 1, () => ({
  pool: undefined as Pool | undefined,
  warnedOnce: false,
}));
```

`globalSingleton` keys the object off a `Symbol.for` on `globalThis`, so every copy of the module gets the same one. The second argument is a shape version: bump it when the object's shape changes incompatibly, so an older copy of the package sharing the process keeps its own state instead of misreading yours. A `let` cannot be shared by reference, which is why a log-once latch becomes a field rather than staying a variable.

Report this even when nothing needed changing, and name the failure it prevents. In `@workflow/world-vercel` the casualty was the WebSocket events transport: the queue consumer registered its channel in one layer's registry and the write path looked it up in another layer's empty one, so every event fell back to HTTP for the life of the process, with nothing logged and no test failing.

## Step 5 — the contract changes

These change no signature. A World ported by types alone compiles and then behaves incorrectly.

- **Suspension dispatch is batched.** The asymmetric `{ timeoutSeconds }` wait-return contract is gone. A wait is an ordinary queue continuation carrying `delaySeconds`, and a suspension dispatches its waits and its steps as one parallel batch. A queue that assumed one message per suspension needs to handle the batch.
- **Step queue topics are retired.** The `'step'` queue kind no longer exists. Queued steps travel on the workflow topic carrying `stepId` and `stepName` in the payload, and execute in the combined flow handler. Drop any `__wkf_step_*` topic provisioning.
- **The `preconditionGuard` capability is gone, and so is the reason for it.** A World that rejected an event creation whose snapshot was behind the log can delete that code and its `stateUpdatedAt` / `stateEventCount` / `stateCursor` plumbing. Bump-and-report replaced it: a stale replay costs a merge instead of a rejection. `PreconditionFailedError` still exists for a World that allocates slots away from the commit and would rather refuse than report, which a World following step 1 is not.
- **Capabilities fail closed.** An unadvertised capability costs performance, never correctness, so a partial World stays correct while it catches up. The reverse is not true: advertising something not enforced removes a guard the runtime was relying on. Set a flag only once the behavior is implemented.
- **Event creation may return a delta.** `events.create()` may return events alongside the one it created, in `events` / `cursor` / `hasMore`. Beyond the bump-and-report case in step 1, the runtime uses this to skip a follow-up `events.list` on `run_started`, on step-terminal writes carrying `sinceCursor`, and on `hook_received` writes carrying `preloadEvents`. All three are advisory: returning only the created event stays correct and pays one more round trip.

## Step 6 — optional surface worth adopting

None of this is required, and the runtime routes around each absence. Report what the World is missing rather than implementing everything unprompted.

`capabilities` (`hookRetention.active`, `hookResumeDedup`, `deploymentAffinity`, `maxConcurrency`), `analytics`, `runs.experimentalSetAttributes`, `runs.cancelMany`, `runs.waitForTerminalStatus()`, `events.createBatch()`, `getRuntimeDeadline()`, `getEnvironment()`, `createRunId()`, `describeRun()`, `getEncryptionKeyForRun()`, `resolveLatestDeploymentId()`, `close()`.

Four are worth raising unprompted because their absence is felt rather than reported:

- Without `getRuntimeDeadline()` the inline replay budget is a flat two minutes, so a host with a long function timeout does less work per invocation than it could.
- Without `close()`, CLI commands and short-lived processes cannot exit cleanly without `process.exit()`.
- Without `events.createBatch()`, a suspension's `step_created` and `wait_created` writes each take their own round trip. Implementing the method *is* the declaration — there is no flag — so it must be atomic per attempt, leaving nothing behind on a lost race, or be left out entirely. It cannot express `run_created`, `run_started`, `run_cancelled`, `hook_created`, `hook_disposed` or `attr_set`, and a World rejects the whole batch when one arrives.
- Without `runs.waitForTerminalStatus()`, `await run.returnValue` falls back to polling on an interval instead of long-polling.

## Step 7 — the rollout

Warn the user, in the migration report, before they deploy:

**Runs already in the store cannot be replayed by the new code.** A ULID-numbered run is not readable as positions, and the runtime refuses it rather than guessing. There is no mixed-scheme mode and no per-run fallback.

Which follows depends on intake item 10. Where a run executes on the deployment that created it, this resolves itself: those runs finish on the build that started them and never meet the new code. Where a single deployment serves every run, the in-flight ones must be drained on the 4.x build before the v5 World is deployed, or they will fail.

## Verification

Wire up the conformance suite first. It is the cheapest way to catch the step 1 work being wrong:

```ts
import { createTestSuite } from '@workflow/world-testing';

createTestSuite('@my-org/my-world'); // or a path to the built entrypoint
```

The suite spawns a server with `WORKFLOW_TARGET_WORLD` set to that value and runs real workflows against it. Its `numbers events by position` test fails a World whose IDs do not decode to slots, whose run is not dense from 1, or whose IDs are not in canonical form. That turns the failure that would otherwise appear on a first replay into one line of test output.

Then run, in order, and report actual output:

1. Build and typecheck the World package.
2. The conformance suite.
3. The World's own test suite.
4. An end-to-end run against a real app, covering: a run that suspends on a step and one that suspends on a wait; a parallel fan-out, so concurrent `events.create()` calls race for the same slot; a hook resumed after its run has progressed; a stream written and read back, including one closed before the reader attaches.

Concurrency is the part that light testing misses. If the World's tests never issue two `events.create()` calls for the same run at once, add one that does before calling the migration done.

Fail the migration if any of these are true:

- [ ] an event ID is produced by anything other than `slotToEventId()`
- [ ] the slot is chosen by reading a maximum, or a counter, outside the operation that commits the event
- [ ] the slot is handed out before the commit
- [ ] `events.create()` rejects, throws or retries a write whose `eventCount + 1` slot was taken, instead of bumping to the next free slot
- [ ] a bumped write returns without the skipped events on `events` / `cursor` / `hasMore`
- [ ] a create carrying no `eventCount` is rejected
- [ ] `specVersion` is a literal, or `SPEC_VERSION_SUPPORTS_SLOT_IDENTITY`, rather than `SPEC_VERSION_CURRENT`
- [ ] a `streams.*` call kept the v4 argument order (name before runId)
- [ ] `steps.get` or `listByCorrelationId` is reachable without a run ID
- [ ] a capability is advertised whose behavior is not implemented
- [ ] a pool, client, socket, registry, cache, ID factory, or log-once latch is still held at module scope
- [ ] `@workflow/world-testing` is not wired up, or its results were not reported
- [ ] the rollout warning in step 7 was not given
- [ ] the build, typecheck or test results were not actually run and reported

## Required output shape

```md
## Summary
## Event ID Allocation
## Interface Changes
## Process-Wide State
## Contract Changes
## Optional Surface Not Implemented
## Rollout
## Verification
## Open Questions
```

- `## Event ID Allocation` states where the slot is now computed, what settles a race for it, and how a bumped write reports the span it skipped. Quote the code.
- `## Process-Wide State` lists every module-scope singleton found and where it moved, or states that there were none.
- `## Optional Surface Not Implemented` lists what was left out and what each absence costs, so the user can decide.
- `## Rollout` carries the step 7 warning and which of its two cases applies to this deployment.

## Reference

- Upgrading a World to v5: <https://workflow.dev/worlds/upgrading-to-v5>
- Building a World: <https://workflow.dev/worlds/building-a-world>
- Event IDs: <https://workflow.dev/docs/how-it-works/event-sourcing#event-ids>
- What's new in v5 (application-facing): <https://workflow.dev/docs/whats-new>
- Reference implementations: `packages/world-local` and `packages/world-postgres` in <https://github.com/vercel/workflow>
