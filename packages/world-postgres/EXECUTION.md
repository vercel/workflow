# Experimental single-owner execution World

This opt-in reference implementation uses the new platform-neutral
`World.execution` contract and PostgreSQL. It runs root workflows in the Node
workflow VM, with sequential inline steps and a serialized journal commit lane.

## Run it

Build the changed packages from the repository root:

```sh
pnpm exec turbo build --filter=@workflow/core...
pnpm --filter @workflow/world-postgres build
```

Configure the application **before its Workflow build**, then run the application's
normal build/start commands:

```sh
export WORKFLOW_TARGET_WORLD=@workflow/world-postgres/execution
export WORKFLOW_POSTGRES_URL=postgres://world:world@localhost:5432/world
```

Use a dedicated test database for this experimental profile. The World creates
the `workflow_execution` schema on first use and initializes Graphile Worker for
durable wake delivery. The database role needs schema/table creation privileges.
Existing workflow event tables are not the execution journal. There is no data
migration into this profile.

For an explicit custom World module:

```ts
import { createWorld as createPostgresExecutionWorld } from '@workflow/world-postgres/execution';

export function createWorld() {
  return createPostgresExecutionWorld({
    connectionString: process.env.DATABASE_URL!,
    applicationManagedShutdown: true,
    queueConcurrency: 50,
  });
}
```

The standard Workflow integration calls `start()` to initialize the worker and
reenqueue nonterminal executions. For manually hosted handlers, expose the normal
Workflow flow endpoint and set `WORKFLOW_LOCAL_BASE_URL` to its base, for example
`http://127.0.0.1:3000/.well-known/workflow/v1`. Stop HTTP ingress and await active
handlers before calling `world.close()`. Application-managed shutdown can also be
selected with `WORKFLOW_POSTGRES_APPLICATION_MANAGED_SHUTDOWN=1`.

Queue namespaces also partition execution records and hook tokens. The default
Graphile job prefix is specific to this profile and namespace. All processes that
share a namespace must run the same workflow code: the reference deployment ID is
`postgres`, so code-version routing is not provided.

## Protocol and durability

- `create` persists arguments and the initial event before publishing a wake.
- `acquire` loads a complete committed prefix. It does not grant ownership.
- The adapter's `createHandler` hosts core's `ExecutionSession`. A session-level
  PostgreSQL advisory lock excludes simultaneous hosts. A separate durable grant
  marks the active owner. A separate connection pool holds these locks so journal
  commits cannot starve behind ownership connections.
- `exchange` locks the execution row and checks ownership, immutable identity and
  exact expected head. Journal changes, receipts and hook-token effects commit in
  one transaction. Every successful step start is durable before the body runs.
- `submit` stages an input in a PostgreSQL inbox, publishes a wake, then waits for
  its **journal receipt**. Inbox persistence alone is not success. A live session
  polls the inbox independently of its awaited body, including for submissions
  from another process. Inbox order is not a promised caller order; the committed
  journal is authoritative.
- Pass a stable `resumeId` when retrying a submission. An exact duplicate returns
  the original result. Reusing an identity with different content quarantines the
  run. A timeout reports an unknown outcome and does not retract the input.
- Inputs must be valid runtime events, such as `hook_received` for a live hook or
  `run_cancelled`. Workflow-origin attribute writes still belong to the workflow's
  deterministic event sequence; arbitrary injected workflow writes will diverge.
- Cleanly suspended sessions release the grant and may later replay their durable
  prefix. A process/connection loss with an outstanding grant is deliberately
  **quarantined**, rather than automatically rerunning an uncertain body.
- Invariant violations record a sticky fault and reject future execution. No slot
  walking, resetting to a newer head, or fallback repair occurs. The fault is
  inspectable in `workflow_execution.runs.fault`. There is no automatic reset API.

Database ownership is not a fence on arbitrary external side effects. Losing a
connection cannot undo or synchronously cancel an already-issued body operation;
the retained grant prevents a replacement from silently running another body.
This is a fail-closed prototype, not an exactly-once side-effect guarantee.

## Current limits

- Root-only Node VM; no scopes, compiler changes, remote step workers, independent
  body leases or renewal API.
- A maximum of 1,024 events / 4 MiB per full snapshot, 32 events per exchange,
  128 KiB per event/input, and 128 unjournaled inputs per run.
- The coordinator schedules a continuation after its 60-second drive budget;
  an individual awaited step body is not interrupted at that boundary.
- Full-snapshot reads and limited legacy read projections are for protocol
  experiments. Global run listing, hook lookup by ID, streams, retention/GC,
  and complete legacy pagination/resolve-data behavior are not implemented.
  Unsupported operations throw explicitly. Hook-token bindings are freed on
  disposal or run termination; minimum token retention is not supported.
- Uncaught workflow/runtime errors currently quarantine the execution. Normal
  step retry handling is reused, but this is not a full production failure policy.

## Verification

Docker is required for the real PostgreSQL/Graphile tests:

```sh
pnpm --filter @workflow/world-postgres exec vitest run test/execution.test.ts src/queue.test.ts
pnpm exec vitest run packages/core/src/runtime/execution.test.ts packages/world/src/execution.test.ts packages/core/src/runtime-world-singleton.test.ts
```

The integration suite covers atomic batches and rollback, duplicate identities,
competing heads, token conflicts, namespace isolation, cross-host ownership,
unclean owner loss, real VM/inline execution, and journal-on-ack hook delivery
through Graphile while a real step remains blocked.
