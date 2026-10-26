---
name: migrating-world-v4-to-v5
description: >-
  Upgrades a custom Workflow SDK World implementation from the v4 spec, or from a 5.0.0 beta, to the current v5 spec (spec version 8). Use when a package implements the `World` interface from `@workflow/world` and is moving to 5.x, or is on a 5.0.0 beta and the runtime reports `This Workflow runtime supports Worlds with spec version 6 through 8, but the configured World declares spec version N`; or when it shows event IDs that are ULIDs rather than slot positions, `Event id is not slot-numbered` at replay time, a `specVersion` the runtime refuses, `writeToStream` / `closeStream` / `readFromStream` as top-level World methods, `steps.get` or `events.listByCorrelationId` without a `runId`, a `'step'` queue kind or `__wkf_step_*` topics, a `preconditionGuard` capability, or a `createLocalWorld` / `createVercelWorld` factory.
metadata:
  author: Vercel Inc.
  version: '0.4.0'
---

# Migrating a World from the v4 spec to v5

This skill is for a package that implements `World` from `@workflow/world`: a storage, queue and stream backend the Workflow runtime talks to. It is not for application code. If the task is bumping an app's `workflow` dependency, use the `migrating-workflow-v4-to-v5` skill instead; if the app both uses Workflow and ships its own World, run that skill first and this one second.

An app on the Vercel, Local or Postgres World needs nothing from this skill. Those ship with the SDK and are already on the v5 spec.

One change dominates the work. **Event ID allocation is required, is not visible from the type signatures, and a World that skips it type-checks, starts runs, and fails on the first replay.** Do that part first, then the mechanical rewrites. Do not begin with the type errors: they are the small half, and finishing them produces a World that looks migrated and is not.

### Which spec version a pin produces

What a World declares follows the `@workflow/world` version it resolves, and the runtime admits a range. Check both before deciding how much work this is.

| `@workflow/world` | `SPEC_VERSION_CURRENT` / `mintedSpecVersion()` | Admitted by `workflow` 5.2.x (range 6 to 8)? |
| --- | --- | --- |
| any 4.x | 5 or below | No |
| `5.0.0-beta.25` and earlier | 5 or below (no slot identity) | No |
| `5.0.0-beta.35` to `beta.37` | 7 | Yes, but not spec 8 |
| `5.0.0-beta.39` and later, all 5.0.x stable | 8 | Yes |

The range is printed by the startup error, and lives in the bundled `@workflow/core` as `assertWorldSupportsRuntimeProtocol`. A host that bundles its own copy of the runtime has its own ceiling: grep the bundle for `supports Worlds with spec version` to read it. Declaring above a host's ceiling makes that host refuse the World at startup, so a World that must also run under older hosts states which host versions each of its releases supports.

**A World already on a 5.0.0 beta** with slot-numbered IDs does not redo step 1. Bump `@workflow/world` and `@workflow/errors` to the stable line, confirm the declaration is `mintedSpecVersion()` (step 2), read the spec 8 notes in step 2, then audit the step 5 contract items and the fail checklist: several of them landed late in the beta line and a beta-era World commonly misses lazy `step_started`, the `runs.list` status array and `resolveData: 'skip-step-inputs'`. Run the conformance suite at the new version before calling it done.

**A World that predates event sourcing** (it exposes `runs.create`, `steps.update` and the like, and has no `events.create` that drives entity state) has no v4 event log to port. The whole `events.create` state machine is written from scratch. Use `packages/world-postgres/src/storage.ts` as the reference and keep its event-by-event structure.

## Intake

Before editing, establish and report each of these:

1. **Where the World is.** Grep for `implements World`, `: World`, `World>` and `from '@workflow/world'`. Read the factory it exports.
2. **How event IDs are minted today.** Grep for `eventId`, `ulid`, `uuid`, `nanoid`, `nextval`, `AUTO_INCREMENT`, `IDENTITY`. Find the exact line that produces the ID written to storage. Note any place an ID is chosen before the write that stores it, for example an ID planned in advance and saved in a claim record so redeliveries reuse it. That design hands out a position before the commit and needs reworking, not porting.
3. **What settles a write race.** Read the `events.create` implementation. Note whether the ID or ordering is decided in process (read-then-write, an in-memory counter, a `Math.max` over loaded events) or in the store (unique constraint, conditional write, `INSERT ... ON CONFLICT`, a transaction).
4. **Which `specVersion` it declares.** Grep for `specVersion`. Note whether it is a literal or an imported constant.
5. **Which optional members exist.** Grep for `capabilities`, `analytics`, `getRuntimeDeadline`, `getEnvironment`, `createRunId`, `describeRun`, `getEncryptionKeyForRun`, `resolveLatestDeploymentId`, `cancelMany`, `experimentalSetAttributes`.
6. **Whether it provisions step topics.** Grep for `'step'`, `__wkf_step`, `stepQueue`.
7. **Whether it rejects stale writes.** Grep for `PreconditionFailedError`, `preconditionGuard`, `stateUpdatedAt`, `stateEventCount`, `stateCursor`, `412`.
8. **Where its process-wide state lives.** Grep the World's modules for top-level `const`/`let` holding a pool, client, socket, registry, cache, ULID factory, or a log-once boolean. Note every one: these are correct in a `require()`d package and wrong in a bundled one.
9. **How it is tested.** Grep for `@workflow/world-testing` and `createTestSuite`. A World without the conformance suite wired up gets it in this migration.
10. **What its store can make atomic.** A transaction, a conditional write or unique constraint, a server-side script (Redis Lua, a Durable Object or actor that is single-threaded per run), or none (a CRDT or eventually consistent store). Step 1 depends on the answer.
11. **Whether bytes survive its storage and queue.** v5 entity data, event data and queue payloads carry `Uint8Array` values (`SerializedData`, `stepInput.input`). Grep for `JSON.stringify`, `JSON.parse`, `Buffer`, `Binary`. A store or transport that round-trips through plain JSON, or hands back a Node `Buffer`, corrupts them silently.
12. **Whether it forwards runtime parameters across a process boundary.** A World whose storage sits behind HTTP, RPC or an actor call serializes `events.create()` params and errors. Note where.
13. **Which host it runs in.** Node, a Worker, a browser, or a host app that bundles its own runtime (step 2 and step 7 depend on this).
14. **Where its runs live.** Ask, or determine from the deployment model, whether a single deployment serves every run or a run is pinned to the deployment that created it. This decides the rollout in step 7 and cannot be read out of the code.

Also record the `@workflow/world` version it pins today and look it up in the table above.

Report anything not applicable rather than skipping it silently.

## Step 1 — event ID allocation

In v4 an event ID was a ULID the World minted however it liked. In v5 an event ID is the event's **position in its run's log**: `evnt_` followed by a 1-based slot, zero-padded to 26 characters, so a run's first event is `evnt_00000000000000000000000001`.

```ts
import { slotToEventId, eventIdToSlot, FIRST_EVENT_SLOT } from '@workflow/world';

slotToEventId(1); // 'evnt_00000000000000000000000001'
eventIdToSlot('evnt_00000000000000000000000042'); // 42
eventIdToSlot('evnt_01JQ...'); // null
```

Every stored ID must equal `slotToEventId(slot)` exactly. Format with `slotToEventId()` wherever the slot is known in process. Where the slot is only known inside the store's atomic operation (the SQL below, a Redis Lua script), formatting there is correct, provided the prefix and width are derived from `slotToEventId()` (for example from `slotToEventId(1)`) rather than retyped, and the World decodes the returned ID with `eventIdToSlot()` before trusting it. When a script injects the ID into JSON the client already serialized, put `eventId` first as a fixed placeholder and replace only its first occurrence; a later field such as a hook token is user-chosen and can contain the same text. The fixed width is what makes lexicographic order the same as positional order, so a World padding to a different width sorts its own log wrongly past ten events.

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

Read the log head **before** the entity state the event validates against, inside the same transaction or retry loop. The slot then fences the validation too: a writer that validated against a stale step or run row loses the slot and re-validates on the retry.

How this maps onto other stores:

- **A store that serializes per run** (a Cloudflare Durable Object, a Rivet actor, any single-threaded owner per run) allocates inside the owner's commit. Nothing else is needed for the event log. Hook tokens are a different matter: they are unique across runs, so they cannot be arbitrated in per-run storage and need a store-wide owner or constraint.
- **A server-side script** (Redis Lua, `WATCH`/`MULTI`) reads the head and appends in the one script or transaction.
- **A conditional write without multi-key transactions** (MongoDB standalone, NATS KV, Cosmos) uses a unique index on `(runId, eventId)` or a put-if-absent on the slot key, and retries on the duplicate. If the entity update and the event cannot commit together, use the store's transactions where its topology allows, and otherwise document the crash window between them.
- **An embedded or synchronous driver** (libSQL `file:`, `better-sqlite3`) also needs an in-process write mutex. A second in-process writer blocks on the database lock synchronously, which blocks the event loop the lock holder needs to finish; busy timeouts do not help. The mutex orders writers inside the process, and the constraint still settles writers across processes.
- **A store with no conditional write at all** (a CRDT, an eventually consistent KV) cannot give uniqueness across writers. Either serialize all appends for a run through one writer and document that single-writer deployment as a requirement, or claim slots with whatever put-if-absent exists and read back only the dense prefix from slot 1. In both cases, make a log that two writers merged fail loudly on load rather than replay out of order. State the guarantee in the World's README.

**Existing keys and rows.** A v4 schema often has a unique index or primary key on `eventId` alone. Two runs now both have `evnt_00000000000000000000000001`, so the second run's first event is rejected. Re-key to `(runId, eventId)`. If old ULID rows (`wevt_...`, `evnt_<ULID>`) stay in the same table, filter slot allocation and range reads to slot IDs: a ULID sorts after every slot ID and does not decode to a slot, so "the highest ID" becomes garbage. Keep pre-slot runs readable and cancellable, and refuse to append to them.

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

`mintedSpecVersion()` is a function because the version a World stamps is a deployment choice: it answers with the current version (9) by default, with the version `WORKFLOW_SPEC_VERSION` names (6 to 9), or with the slot-identity version (6) when `WORKFLOW_SEALED_LOG=0` opts new runs out and `WORKFLOW_SPEC_VERSION` is unset. Both are inside the accepted range. Call it inside `createWorld()` rather than caching it at module load, so one process can create Worlds in both modes.

Its parameter defaults to `process.env`. Where `process` does not exist (a browser, a Worker without `nodejs_compat`) the bare call throws a `ReferenceError`. Pass the environment explicitly: `mintedSpecVersion(config.env ?? globalThis.process?.env ?? {})`.

When an event or run arrives without a `specVersion` and the World fills one in, use the version the World declared, not `SPEC_VERSION_CURRENT`, which ignores `WORKFLOW_SPEC_VERSION` and `WORKFLOW_SEALED_LOG`.

If `@workflow/world` is only a type-level or peer dependency and the World reimplements `mintedSpecVersion()` locally to avoid a runtime import, the local copy pins a number by another route and falls behind on the next bump. Report it as a finding.

Report any of these as findings rather than leaving them:

- A hard-coded number. It leaves the World a version behind the next bump and gets it rejected by the runtime it ships alongside.
- `SPEC_VERSION_CURRENT` or `SPEC_VERSION_SUPPORTS_SLOT_IDENTITY` used as the declaration. Both are literals by another name here, since neither follows the sealed-log setting.
- Code that assumes every run matches what the World declares today. A run's version is persisted at creation and kept for life, so read it off the run.

### The sealed log and `noop`

The sealed-log version permits one alternative to allocating a position at the commit (step 1): hand positions out from a per-run counter *before* the commit, so concurrent writers never race for one, then restore density at read time by writing a `noop` event into any position provably abandoned. A `noop` occupies its position and means nothing — replay steps over it without delivering it and without advancing the deterministic clock.

For most migrations this is a no-op, and say so rather than skipping it: **a World that allocates at the commit is already compliant** and will never emit a `noop`, because no write can leave a position empty. Only build the sealing half if the World pre-assigns positions, and then it must also never return a page with an interior hole — return the dense prefix below the hole and let the next page pick up once the position resolves.

The half that always applies is the reader's: `noop` is not user-creatable, never sent to `events.create()`, and only the World's own read path may write one. If the World validates event types on read, make sure `noop` parses.

### Spec 8 and hook token takeover

Spec 8 is also a reader contract. A run stamped 8 is one whose runtime understands an *involuntary* hook disposal: a `hook_disposed` carrying `forceClaimedBy`, written into its log by another run's `createHook({ token, experimental_force: true })`. Its awaiters reject with `HookForceClaimedError` instead of hanging.

**Declaring 8 costs a World nothing it has to build.** Takeover itself is behind `capabilities.hookForceClaim`, which fails closed: a World that does not advertise it never writes `forceClaimedBy`, and the runtime fails a forced `createHook()` at registration. Say so in the report rather than leaving the capability unmentioned.

A World that does implement takeover takes on these obligations, and only advertises the flag once all of them hold:

- On a forced `hook_created` for a token a live run holds, append `hook_disposed` with `forceClaimedBy: { runId, hookId }` to the holder's log, refuse later `hook_received` writes to the holder's hook, re-point the token to the claimer, and record `Hook.claimedFrom`.
- Refuse the takeover with an ordinary `hook_conflict` carrying `forceRefusedReason: 'victim-spec-version'` when the holder run was stamped below 8. A reader below 8 would treat the disposal as its own `dispose()` and strand every `await hook`.
- A finished holder has no reader to strand, so a retained token is taken over at any version.
- Answer a `hook_received` refused by a takeover with `HookForceClaimedError`, so `resumeHook()` can follow the token.

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
| `getStreamInfo(name, runId)` | `streams.getInfo(runId, name)` |

The argument order flipped, so moving the methods without swapping arguments passes a stream name where a run ID is expected and type-checks whenever both are `string`. `readFromStream` had no `runId` at all; `streams.get` requires one, so thread the owning run through.

`streams.get` returns a live stream: it keeps delivering chunks as they are written and ends only when the stream is closed. Returning a snapshot of the chunks present at call time is the common v4 shortcut and breaks any reader that attaches before the writer finishes. `streams.getChunks` is the snapshot method.

`streams.streamFlushIntervalMs` sets the flush window. The v5 default is `0`, so the first chunk flushes immediately. Set a value only to deliberately coalesce writes.

### `events.get(runId, eventId)` is required

Storage exposes `events.get` for a single event by its position. Implement it as a keyed read on `(runId, eventId)`.

### `steps.get()` requires a `runId`

The first parameter was `string | undefined` and is now `string`. A World that looked a step up by ID alone needs the run in its key or its index.

### `events.listByCorrelationId()` requires a `runId`

A correlation ID identifies a step, hook or wait within its run, not across runs. Scope the lookup to one run. A World that paginates by event ID needs the run in its cursor comparison too, since two runs can now hold the same correlation ID.

`analytics.events.listByCorrelationId()` took the same `runId`, and is now deprecated on top of it: it is a special case of `analytics.events.list({ runId, correlationId })` and goes away in the next major. Port it for now, and do not build anything new on it. The **storage** `events.listByCorrelationId()` above is not deprecated and keeps its own endpoint.

### `resolveData: 'skip-step-inputs'`

Event reads take `EventsResolveData`, which adds `'skip-step-inputs'` to `'all'` and `'none'`. Treat any value other than `'none'` as `'all'` unless the World implements the input skip, and use `entityResolveData()` from `@workflow/world` to map it for run, step and hook payloads. The conformance suite exercises it.

### Queue names carry no kind

`parseQueueName()` returns `{ prefix, id }` and no longer returns `kind`. A World that chose a `/step` or `/flow` route from `kind` now sends everything to the step route in plain JavaScript without a type error. Deliver every message to the flow route (`createWorkflowUrl(base, { type: 'flow' })` where the World builds URLs). `handleHealthCheckMessage(healthCheck, worldSpecVersion)` takes the World's spec version, and the separate step health-check endpoint is gone.

### Errors are matched by class

The runtime branches on the error class through `.is()`, not on an HTTP status. `WorkflowAPIError` no longer exists in `@workflow/errors` 5.x; use `WorkflowWorldError`. Tests that assert `err.status` need rewriting.

| Condition | Throw |
| --- | --- |
| Duplicate `step_created`, `hook_created` or `wait_created`; a second `wait_completed`; losing a lazy `step_started` create-claim | `EntityConflictError` |
| `step_started` on a step that is already completed or failed | `EntityConflictError` |
| `step_started` before the step's `retryAfter` | `TooEarlyError`, with `retryAfter` in seconds |
| `run_started` or `step_started` on a run that is `completed`, `failed` or `cancelled` | `RunExpiredError` |
| The run does not exist | `WorkflowRunNotFoundError` |
| The hook does not exist on `hook_received` or `hook_disposed` | `HookNotFoundError` |

A World whose storage sits behind HTTP, RPC or an actor call must rebuild these classes on the caller's side. If the boundary masks the error to a generic message, the runtime takes the wrong branch.

### Forward only the parameters the World reads

`events.create()` params can carry process-local values: `replayEventObserver` is a function the runtime passes on `run_started` and on the `hook_received` preload. A World that serializes the whole params object across a boundary fails on it (CBOR and structured clone both refuse functions). Forward the fields the World actually uses, such as `resolveData`, `eventCount`, `skipPreload`, `sinceCursor` and `resumeId`, and ignore the rest.

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

What has to move is state the World *looks up* from a different layer than the one that wrote it: a registry, a shared pool or client a request handler reaches, a cache read by another entrypoint. State that is keyed to the World object itself (a `WeakMap` keyed by the client the World holds) travels with that object and is safe. A ULID factory is not safe if anything sorts by its output: two bundled copies, each with its own monotonic factory, mint IDs in the same millisecond that interleave out of order, which reorders stream chunks sorted by ID.

Report this even when nothing needed changing, and name the failure it prevents. In `@workflow/world-vercel` the casualty was the WebSocket events transport: the queue consumer registered its channel in one layer's registry and the write path looked it up in another layer's empty one, so every event fell back to HTTP for the life of the process, with nothing logged and no test failing.

## Step 5 — the contract changes

These change no signature. A World ported by types alone compiles and then behaves incorrectly.

- **Suspension dispatch is batched.** A wait is an ordinary queue continuation carrying `QueueOptions.delaySeconds`, and a suspension dispatches its waits and its steps as one parallel batch. A queue that assumed one message per suspension needs to handle the batch, and must turn `delaySeconds` into a delivery delay.
- **Handlers still return `{ timeoutSeconds }`.** The queue handler the runtime registers can still resolve with `{ timeoutSeconds: n }`, meaning "redeliver this message in n seconds", and `0` means redeliver now. Check it with `typeof result?.timeoutSeconds === 'number'`; a truthiness check drops the zero-delay reschedule and strands the run. A rejected handler must also lead to redelivery with an incremented attempt. A transport that gives up after a fixed number of retries satisfies this by enqueueing a delayed copy under the same `messageId` and acknowledging the current delivery.
- **The handler is registered lazily.** The runtime calls `createQueueHandler` when its flow route (`/.well-known/workflow/v1/flow`) first handles a request. A World that dispatches in process through a handler registry finds nothing registered until that route has run once; deliver over HTTP to the route, or tolerate the empty registry by retrying.
- **Payloads are bytes.** Entity data, event data and queue payloads carry `Uint8Array`. `StepDispatchInputSchema` requires `stepInput.input` to be one. Store and return plain `Uint8Array`, not a Node `Buffer` (a `Buffer` JSON-encodes as `{ type: 'Buffer', data }` and fails hydration) and not a driver wrapper such as MongoDB's `Binary`. A JSON queue transport needs a tagged envelope; `@workflow/world-local` uses `{ __type: 'Uint8Array', data: <base64> }`. Keep the body JSON with `runId` at the top level, which the conformance suite reads.
- **Step queue topics are retired.** The `'step'` queue kind no longer exists. Queued steps travel on the workflow topic carrying `stepId` and `stepName` in the payload, and execute in the combined flow handler. Drop any `__wkf_step_*` topic provisioning. If the World exports its own queue API (stats per queue kind, a worker per kind), dropping the step queue changes that API: release it as a breaking change, and drain messages left on the old step queue during the rollout. A World that serialized workflow deliveries per run (one in flight per run) must now key that on messages without a `stepId` only; otherwise it also serializes step bodies and a parallel fan-out runs one step at a time. A transport with no delayed publish can honor `delaySeconds` with a `notBefore` in the envelope and a consumer-side negative acknowledgement until it is due, counted as a suspension rather than a failed delivery.
- **The `preconditionGuard` capability is gone, and so is the reason for it.** A World that rejected an event creation whose snapshot was behind the log can delete that code and its `stateUpdatedAt` / `stateEventCount` / `stateCursor` plumbing. Bump-and-report replaced it: a stale replay costs a merge instead of a rejection. `PreconditionFailedError` still exists for a World that allocates slots away from the commit and would rather refuse than report, which a World following step 1 is not.
- **Capabilities fail closed.** An unadvertised capability costs performance, never correctness, so a partial World stays correct while it catches up. The reverse is not true: advertising something not enforced removes a guard the runtime was relying on. Set a flag only once the behavior is implemented.
- **Event creation may return a delta.** `events.create()` may return events alongside the one it created, in `events` / `cursor` / `hasMore`. The three travel together: return all of them or none. `events.create` is overloaded, so type the implementation as `(runId: string | null, data: AnyEventRequest, params?: CreateEventParams)` and cast the object `as Storage['events']`, as `@workflow/world-postgres` does. When the World answers a `sinceCursor`, do not also narrow `events` down to the bump-and-report span. Beyond the bump-and-report case in step 1, the runtime uses this to skip a follow-up `events.list` on `run_started`, on step-terminal writes carrying `sinceCursor`, and on `hook_received` writes carrying `preloadEvents`. All three are advisory: returning only the created event stays correct and pays one more round trip.
- **`step_started` can create the step.** With inline step ownership, which `@workflow/core` 5.2 uses by default and no capability gates, the runtime sends `step_started` carrying `eventData.stepName` and `eventData.input` for a step that has no `step_created` yet. The World must, in one write: create the step, append a synthetic `step_created` at the slot before the `step_started`, store the `step_started` without `input`, and return `stepCreated: true`. This is a create-claim: exactly one concurrent caller wins, and every other caller gets `EntityConflictError`, which the runtime treats as "skipped". Returning the existing step to the loser makes it run the body a second time. A World without this fails every inline step with `Step "…" not found`. See `lazyStepStart` in `@workflow/world-postgres`.
- **`step_started` on a finished step is refused.** The runtime does not inspect the status of the step a `step_started` returns. A World that accepts the start of a step already `completed` or `failed` re-runs its body; throw `EntityConflictError`.
- **`run_started` can create the run.** When the run does not exist and `eventData` carries its creation data (`deploymentId`, `workflowName`, `input`), create it and its `run_created` at slot 1, then the `run_started`. A `run_started` on a run that is already running returns `{ run }` with no event: a synthesized event names a slot nothing occupies.
- **Waits are entities.** `wait_created` stores a wait, `wait_completed` completes it, and a second `wait_completed` is refused with `EntityConflictError`. A run reaching a terminal state deletes its waits.
- **Errors are serialized data.** `run_failed`, `step_failed` and `step_retrying` carry `eventData.error` as `SerializedData`. Store it verbatim, return it as `run.error` / `step.error`, and persist `errorCode` on the run. A World that rebuilds `{ message, stack, code }` objects stores "Unknown error"; one with a strict schema (SQL columns, SurrealDB `SCHEMAFULL`) needs a migration.
- **Attributes and lineage.** `run_created.eventData.attributes` carries the run's initial attributes, including `$parentRunId` and `$rootRunId`; persist them on the run. `attr_set` updates them; validate and apply with `validateAttributeChanges()` and `applyAttributeChanges()` from `@workflow/world`.
- **Entities gained fields.** Runs: `attributes`, `errorCode`, `encryptionPublicKey`, `dynamicWorkflowCode`. Hooks: `isSystem`, `tokenRetentionUntil`, `resumeContext`, `resumeCapabilities`, `claimedFrom`. Events: `resumeId`. A strict schema drops the ones it does not declare without an error. Store every field the World's advertised behavior reads, and decide explicitly about the rest.
- **Hook tokens are unique across runs.** A `hook_created` whose token another live run holds gets `hook_conflict`. A World that keeps all state per run must arbitrate tokens somewhere global.
- **Client-supplied run IDs are validated.** A run ID the caller provides must pass `validateUlidTimestamp()`. Test fixtures with IDs like `wrun_test_1` fail.
- **A terminal run refuses `step_started`.** The World is where run liveness is enforced, because it is the only party that sees the run row and the claim in one operation. Reject a `step_started` whose run is already `completed`, `failed` or `cancelled`, *even when the step row still reads `running`*. That combination is a redelivery of a start some earlier delivery already claimed, and accepting it executes a step body whose outcome nothing will ever read. `step_completed` and `step_failed` stay accepted on a terminal run, so a step already in flight can still record its outcome. `@workflow/world-local` and `@workflow/world-postgres` both throw `RunExpiredError` here. This is load-bearing rather than defensive: step-execution messages now carry the run's immutable identity (`runContext` on `WorkflowInvokePayload`) so the consumer can skip a blocking `runs.get`, and run *status* is deliberately absent from it. The claim is the only liveness check left. A World whose queue re-serializes payloads through a field allowlist must pass `runContext` through unchanged, or every step dispatch silently falls back to the extra round trip.
- **`runs.list` accepts an array of statuses, and the runtime relies on it.** `reenqueueActiveRuns()` from `@workflow/world`, which a World calls in `start()` to recover in-flight runs after a restart, lists `status: ['pending', 'running']`; a World that only handles a single status recovers nothing and logs nothing. `ListWorkflowRunsParams.status` is `WorkflowRunStatus | WorkflowRunStatus[]`; with an array, a run matches if its status is any of the listed ones. `status: []` matches nothing, mirroring SQL `IN ()`, and is distinct from omitting the field. A World that types the parameter as a plain string compiles against the old shape and then filters on `status = '[object Array]'`, or throws, depending on the store. Implement it, or reject the array form with an explicit error rather than silently returning the wrong page: `@workflow/world-vercel` takes the second route today and throws `WorkflowWorldError` with `INVALID_ARGUMENT`, because its backend has no multi-status filter yet.

## Step 6 — optional surface worth adopting

None of this is required, and the runtime routes around each absence. Report what the World is missing rather than implementing everything unprompted.

`capabilities` (`hookRetention.active`, `hookResumeDedup`, `hookForceClaim`, `deploymentAffinity`, `maxConcurrency`, `dynamicWorkflowCode`, `inBandFence`), `analytics`, `analytics.events.getMany()`, `runs.experimentalSetAttributes`, `runs.cancelMany`, `runs.waitForTerminalStatus()`, `events.createBatch()`, `streams.createWriteSession()`, `getRuntimeDeadline()`, `getEnvironment()`, `createRunId()`, `describeRun()`, `getEncryptionKeyForRun()`, `resolveLatestDeploymentId()`, `close()`.

Four are worth raising unprompted because their absence is felt rather than reported:

- Without `getRuntimeDeadline()` the inline replay budget is a flat two minutes, so a host with a long function timeout does less work per invocation than it could.
- Without `close()`, CLI commands and short-lived processes cannot exit cleanly without `process.exit()`.
- Without `events.createBatch()`, a suspension's `step_created` and `wait_created` writes each take their own round trip. Implementing the method *is* the declaration — there is no flag — so it must be atomic per attempt, leaving nothing behind on a lost race, or be left out entirely. It cannot express `run_created`, `run_started`, `run_cancelled`, `hook_created`, `hook_disposed` or `attr_set`, and a World rejects the whole batch when one arrives.
- Without `runs.waitForTerminalStatus()`, `await run.returnValue` falls back to polling on an interval instead of long-polling.
- Without `streams.createWriteSession()`, the runtime writes through the stateless `write` / `writeMulti` / `close` methods, which is correct and costs a transport setup per write. Implement it when holding state across one writer's chunks buys something, for example keeping a connection open. The runtime creates at most one session per in-memory `WritableStream` and passes a `writerId`, so the session's `write(chunkSeq, chunks)` gets a sequence number that is writer-local rather than stream-global. That is what lets the World order concurrent writers to the same stream. `close()` must not resolve before every prior write is durable; `dispose()` is optional and releases transport resources without ending the stream.

Two limits bind an `analytics` implementation once it exists, and the runtime enforces both in-process, as a `RangeError`, before a request leaves the caller. A request that reaches the World is already inside them, so treat them as the contract rather than re-validating: `pagination.limit` defaults to 40 and caps at 1000 for the run-scoped listings (`steps.list`, `events.list`, `waits.list`) and at 100 for the cross-run ones (`runs.list`, `attributes.list`, `hooks.list`); `analytics.events.getMany()` takes 1 to 100 event IDs within one run, is not paginated, and omits IDs analytics has not ingested yet rather than throwing.

## Step 7 — the rollout

Warn the user, in the migration report, before they deploy:

**Runs already in the store cannot be replayed by the new code.** A ULID-numbered run is not readable as positions, and the runtime refuses it rather than guessing. There is no mixed-scheme mode and no per-run fallback.

**Every host must be able to read what the World stamps.** A World declaring 8 is refused at startup by any runtime whose ceiling is 7, which includes `workflow` 5.0.0-beta.35 to beta.37 and hosts that bundle a runtime from that range. Bump the `workflow` dependency of every example and host app the World ships with in the same change, and if users run it under a host that pins its own runtime, say in the README which World release pairs with which host release.

Which follows depends on intake item 14. Where a run executes on the deployment that created it, this resolves itself: those runs finish on the build that started them and never meet the new code. Where a single deployment serves every run, the in-flight ones must be drained on the 4.x build before the v5 World is deployed, or they will fail.

## Verification

Wire up the conformance suite first. It is the cheapest way to catch the step 1 work being wrong:

```ts
import { createTestSuite } from '@workflow/world-testing';

createTestSuite('@my-org/my-world'); // or a path to the built entrypoint
```

The suite spawns a server with `WORKFLOW_TARGET_WORLD` set to that value and runs real workflows against it. Practical requirements:

- `WORKFLOW_TARGET_WORLD` must name a module plain `node` can load (built `dist`, not TypeScript source) whose `createWorld()` works with no arguments, configured from environment variables. A World that needs platform bindings (a Worker's D1 or Durable Objects) supplies a harness entry that builds them in process.
- The spawned servers bind random ports and do not set `PORT` or `WORKFLOW_SERVICE_URL`; a World that delivers over HTTP to its own server needs to discover the port.
- The backing service must be reachable through the World's environment variables, and each run needs a fresh database or a per-test-file key prefix: the servers share the store and recover each other's leftover active runs.
- The two in-band fence tests skip unless the World advertises `capabilities.inBandFence`. Those skips are expected; report them as skips, not failures.
- The inline-execution tests count flow invocations by parsing each POST body as JSON and reading a top-level `runId`. A World whose transport sends an empty body, a CBOR body or its own envelope fails them while working correctly. Report that rather than changing the transport only for the suite.
- Installing a just-released `@workflow/world-testing` with pnpm can need `npm_config_min_release_age=0` in the environment, and pnpm 11 or later fails `--frozen-lockfile` with `ERR_PNPM_IGNORED_BUILDS` (from `esbuild`, `@swc/core`) unless `allowBuilds` is set in `pnpm-workspace.yaml`.
- Check that the World's existing test setup still passes against the current release of its own database image before attributing failures to the migration.
- The spawned servers load the World's built output, so rebuild before every run or the suite silently tests the previous code.
- An in-memory test double for a per-run actor or Durable Object must serialize per run the way the real object does, or concurrency tests fail spuriously or pass for the wrong reason. Pair it with a run against the real runtime (for example `workerd`). Concurrent servers also expose lazy one-time initialization that assigns handles across `await`s; memoize the initialization promise instead of guarding on a handle. Its `numbers events by position` test fails a World whose IDs do not decode to slots, whose run is not dense from 1, or whose IDs are not in canonical form. That turns the failure that would otherwise appear on a first replay into one line of test output.

Then run, in order, and report actual output:

1. Build and typecheck the World package.
2. The conformance suite.
3. The World's own test suite.
4. An end-to-end run against a real app, covering: a run that suspends on a step and one that suspends on a wait; a parallel fan-out, so concurrent `events.create()` calls race for the same slot; a hook resumed after its run has progressed; a stream written and read back, including one closed before the reader attaches.

Concurrency is the part that light testing misses. If the World's tests never issue two `events.create()` calls for the same run at once, add one that does before calling the migration done: a fan-out of 20 or more `step_created` writes from separate clients, all sending the same stale `eventCount`, then assert the log is dense from 1 and each bumped write reported exactly the slots it skipped. Add a second one racing several lazy `step_started` writes for the same step, and assert exactly one gets `stepCreated: true`. Mint unique correlation IDs per test, since many Worlds key steps globally, and use a connection pool rather than one connection (a single `mysql2` connection interleaves concurrent transactions and produces misleading failures).

Fail the migration if any of these are true:

- [ ] a stored event ID differs from `slotToEventId(slot)` for its slot
- [ ] the slot is chosen by reading a maximum, or a counter, outside the operation that commits the event (a counter advanced in the same transaction as the insert is fine: it commits and rolls back with the event)
- [ ] the slot is handed out before the commit
- [ ] `events.create()` rejects, throws or retries a write whose `eventCount + 1` slot was taken, instead of bumping to the next free slot
- [ ] a bumped write returns without the skipped events on `events` / `cursor` / `hasMore`
- [ ] a create carrying no `eventCount` is rejected
- [ ] `specVersion` is a literal, `SPEC_VERSION_CURRENT`, `SPEC_VERSION_SUPPORTS_SLOT_IDENTITY`, or a local reimplementation, rather than `mintedSpecVersion()` from the resolved `@workflow/world`
- [ ] the resolved `@workflow/world` mints a version outside the range of the runtime the World's users install (see the table at the top)
- [ ] `capabilities.hookForceClaim` is advertised without the spec 8 refusal for holders below 8
- [ ] a `step_started` carrying `stepName` and `input` for a missing step fails instead of creating it, or more than one concurrent caller gets `stepCreated: true`
- [ ] a `step_started` is accepted on a step that is already completed or failed
- [ ] a `Uint8Array` comes back as a `Buffer`, a driver wrapper, or a JSON object
- [ ] errors cross a process boundary without keeping their class
- [ ] a `streams.*` call kept the v4 argument order (name before runId)
- [ ] `steps.get` or `listByCorrelationId` is reachable without a run ID, or `events.get` is missing
- [ ] a `step_started` is accepted on a run in a terminal state
- [ ] `ListWorkflowRunsParams.status` is typed or handled as a single status only, and the array form is neither implemented nor explicitly rejected
- [ ] a capability is advertised whose behavior is not implemented
- [ ] a pool, client, socket, registry, cache, ID factory, or log-once latch is still held at module scope
- [ ] `@workflow/world-testing` is not wired up, or its results were not reported
- [ ] the rollout warning in step 7 was not given
- [ ] the build, typecheck or test results were not actually run and reported

## Required output shape

```md
## Summary
## Spec Version
## Event ID Allocation
## Interface Changes
## Process-Wide State
## Contract Changes
## Optional Surface Not Implemented
## Rollout
## Verification
## Open Questions
```

- `## Spec Version` states the `@workflow/world` version pinned before and after, what it mints, the runtime range it was checked against, and whether `hookForceClaim` is advertised.
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
