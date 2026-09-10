# Vercel actor World (experimental POC)

`@workflow/world-vercel-actors` tests one affinity-routed primary per workflow
run. It uses the root-only `actor-owner-v1` execution protocol and executes steps
inline. It is not a production replacement for `@workflow/world-vercel`.

## Configuration

Install this package alongside `workflow` and select it **at build and runtime**:

```text
WORKFLOW_TARGET_WORLD=@workflow/world-vercel-actors
WORKFLOW_ACTOR_AFFINITY_HEADER=<platform-supplied-header-name>
VERCEL_WORKFLOW_SERVER_URL=<workflow-server deployment with actor POC enabled>
```

The header name is deliberately not guessed. It is sent with the full run ID
on every VQS delivery, with the run's recorded deployment as the target. The
receiving flow route validates that the delivered affinity header equals the
decoded message's run ID before executing user code.

The Build Output API builder emits strict affinity and `iad1` for this World.
The test deployment must be an affinity-capable service whose queue trigger
accepts those headers. Existing framework-generated flow routes select the
actor entry point at runtime when this World is loaded; framework-specific
service packaging still needs platform validation. A header alone is not proof
that routing honored affinity. Do not enable `WORKFLOW_SEQUENTIAL_REPLAYS` for
the experiment: it would mask the routing guarantee with queue serialization.

Inside a deployment, authentication and per-run encryption use the existing
Vercel World helpers. Outside a deployment, call `createWorld(config)` with the
same explicit API/project credentials as the Vercel World. `affinityHeader`
can configure external clients; cells require the environment variable above.

## Behavior

- Creation persists first, then publishes the initial execution delivery.
- A process-wide registry shares initialization and one coordinator per run.
- The primary serializes durable appends. Bodies execute outside that commit
  lane, so an incoming hook can be journaled while a body is waiting on I/O.
- Steps use a bounded sequential inline lane. There is no remote overflow.
- External `hook_received`, `hook_disposed`, cancellation, and attribute inputs
  travel via VQS and wait for a durable operation receipt before returning.
- `submitTimeoutMs` (client option, default 60 seconds) limits that receipt wait.
  Timeout is an unknown outcome, not proof that the input was discarded.
- Owner events use expected-head commits with immutable receipts. A mismatch,
  changed duplicate, invalid prefix, wrong target, or declined retained session
  stops the coordinator and persists a separate fault marker. No slot walking,
  corrected-head retry, legacy fallback, or catch-and-replay occurs.
- Ordinary cold activation replays the committed history; a persisted fault
  prevents a replacement process from resuming a quarantined run.
- Hook/sleep waits release the invocation. Delayed VQS deliveries wake it later;
  the retained VM is a cache, not permission for uninvoked background CPU.

## Deliberate POC limits

The server owns an isolated bounded actor journal with its own hook directory.
The adapter derives run/step/hook read models from that journal. Existing
multi-writer log APIs never participate in these commits.

Only `iad1`, the Node VM, and inline bodies are supported initially. The server
bounds runs to 1,024 events and 4 MiB of journal bytes, individual events to
128 KiB, and a receipt to 256 KiB. Unsupported/oversized operations fail rather
than silently selecting another World. The process registry is bounded to 128
coordinators; lifecycle eviction is follow-up work for this experiment.

Native analytics/listing, native stream projections, minimum hook retention,
cross-region hook ownership, remote execution, automated fault repair, and
production retention/billing integration are not supplied by this POC. Streams
and unsupported listings throw explicitly. Argument/result values requiring
stream transport are therefore unsupported; ordinary serialized values work.

This World adapts the newer execution boundary rather than falsely implementing
body leases: `create`, `acquire` (load, not election), `exchange`, and `submit`
are supported, with receipt lookup and quarantine control. Inline admission is
an ordered `step_started`; there is no fake `renew` success or durable RAM inbox.

## Validation

The protocol and coordinator tests cover prefix integrity, expected-head
failure, sticky faults, duplicate receipts, concurrent arrival, inline ordering,
and no automatic replay after a retained-session violation. Platform tests must
also observe compute-instance continuity under concurrent delivery; database
head assertions alone do not prove placement uniqueness or exactly-once effects.

Counterpart: the workflow-server actor-owner POC routes under
`/api/v1/actor-executions/`. Both PRs must be used together.
