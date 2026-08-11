# `@workflow/world-sim`

A deterministic, fully in-memory World for **playing out workflow scenarios**
and **checking that the world contract holds**.

It exists to answer questions that a real World cannot be asked, because in a
real World they are races:

> What happens if the approval webhook arrives *after* `step_started` is
> durable but *before* the workflow gets control back?

In `@workflow/world-local` you would answer that by polling in a loop and
hoping. Here you state it, and it is what happens — every time, byte for byte.

```ts
const wf = sim.writer.orchestrator();
await wf.runToEventCommitted('step_started', 'reserveInventory');
await sim.deliverHook('approval:doc-1', { approved: true });
await wf.release();
```

The resulting event stream:

```
  0     +0ms  wf                run_created       approvalWorkflow input=<17B>
  1     +0ms  wf                run_started
  2     +0ms  wf                hook_created     hook_…KX  token="approval:doc-1"
  3     +0ms  wf                step_created     step_…KY  reserveInventory input=<58B>
  4     +0ms  wf                step_started     step_…KY  reserveInventory
        +0ms  wf                >> held "orchestrator -> step_started step=reserveInventory (committed)" at events.create:after
  5     +0ms  ext                 hook_received    hook_…KX  token="approval:doc-1" payload=<44B>
  6     +0ms  reserveInventory  step_completed   step_…KY  reserveInventory result=<22B>
  …
```

The second column names the writer. The indented `hook_received` is written by
the scenario (`ext`) from *inside* the `events.create` call that committed
`step_started`, while the orchestrator is stopped in it. Advance a different
writer instead — `sim.writer.step('reserveInventory')` — and the same workflow,
same input and same output produce a different log, which is the point.

---

## The model

Three rules, and everything else follows from them.

**1. The World API is the schedule.** Every method is wrapped so a scenario can
run code `before` a call starts, or `after` its effect is committed but before
the awaiting caller is resumed. Since the World API is the only channel between
the runtime and the outside, that is a complete set of injection points.

**2. Nothing happens on its own.** `queue()` records a message and returns; it
never dispatches. The scheduler picks the next message — always the minimum by
`(readyAt, enqueueSeq)` — hands it to the flow handler, and waits for it to
finish before looking again. One delivery is in flight at a time.

**3. Time is a number the scheduler assigns.** `sleep('30d')` becomes a queue
message dated 30 days out; delivering it means moving the clock, not waiting.
`Date.now()` and `new Date()` read the virtual clock while a scenario runs
(timers are left alone — the runtime uses zero-delay macrotasks as ordering
barriers, and faking those would change the interleavings we came to observe).

Consequence: **scenarios terminate**. A month-long sleep costs microseconds. A
hook nobody delivers drains the queue and is reported as a *stall*, naming the
token that was never sent, instead of hanging. Delivery count, virtual span and
wall time are all capped as a backstop.

## Consistency checking

Every scenario ends with the event log re-read and the entity state
re-derived from it. `checkInvariants` verifies, among others:

| Rule | What it means |
| --- | --- |
| `log.monotonic-order` | Append order equals `(createdAt, eventId)` sort order — replay sees what happened |
| `run.created-first`, `run.created-once`, `run.terminal-is-last` | Run lifecycle shape (a step already running may still close out after termination) |
| `step.no-restart-after-terminal`, `step.terminal-once` | A finished step stays finished |
| `step.entity-matches-log`, `step.attempt-matches-log`, `run.entity-matches-log` | Materialized rows are a pure fold of the log |
| `hook.token-unique`, `hook.no-receive-after-dispose` | One live hook per token; disposal is final |
| `wait.resume-at-stable`, `wait.completed-once` | A wait's deadline is not rewritten (the sleep consumer treats a change as replay divergence) |

### Replay verification

Shape checks say the log is well formed. They do not say the log is *enough* —
that a fresh process handed it would rebuild the same run. That is the property
durability actually rests on, so every scenario that reaches `completed` or
`failed` ends with a cold start:

1. Take the committed log and withhold its terminal `run_*` event.
2. Seed the rest into an empty world as durable history.
3. Deliver one queue message to the same `workflowEntrypoint` a deployment
   serves, with the clock pinned to the instant the run ended.
4. The runtime must replay from the log alone and re-derive the event that was
   withheld, with the same output.

No step body re-executes — every `step_completed` is in the log, so the step
consumer resolves from it — which means anything the replay produces came from
the log and nothing else. Failures are named:

| Rule | What happened |
| --- | --- |
| `replay.diverged` | The runtime could not follow its own history: `REPLAY_DIVERGENCE` / `CORRUPTED_EVENT_LOG` |
| `replay.suspended` | The replay ran out of log before the workflow finished |
| `replay.output-differs`, `replay.status-differs` | It finished, with a different answer |
| `replay.log-differs` | It re-derived a different tail than the one withheld |

Skipped for `cancelled` and `stalled` runs: their terminal event came from an
operator, or never existed, so there is no workflow-derived answer to reproduce.

The store itself is a compact reference implementation of the same event →
entity state machine `@workflow/world-local` implements on the filesystem, with
all of that world's cross-process race machinery (claim files, per-entity
locks, staged hook events, canonical event-id pinning) removed — a scenario is
single-threaded, so those races cannot occur. Every *validation* is kept,
because rejections are the observable contract the runtime is written against.

## Usage

```ts
import {
  buildSimBundle,
  loadFlowHandler,
  renderScenario,
  runScenario,
} from '@workflow/world-sim';

// The orchestrator runs from a code string inside a VM, so a scenario needs
// the same compiled bundle a deployment would serve.
const bundle = await buildSimBundle({ cwd: process.cwd(), dirs: ['workflows'] });
const handler = await loadFlowHandler(bundle.flowBundlePath);

const result = await runScenario(
  {
    name: 'hook arrives inside the step_started commit',
    // Named from the build manifest — no client transform needed.
    workflow: 'approvalWorkflow',
    input: ['doc-1'],
    script: async (sim) => {
      const wf = sim.writer.orchestrator();
      await wf.runToEventCommitted('step_started', 'reserveInventory');
      await sim.deliverHook('approval:doc-1', { approved: true });
      await wf.release();
    },
    expect: { status: 'completed' },
  },
  { handler, workflowIds: bundle.workflowIds }
);

console.log(renderScenario(result));
```

`workbench/sim-world` is a worked example: `pnpm sim` builds its workflows,
plays 39 scenarios, prints every event stream, and exits non-zero if any
expectation or invariant fails.

`expect` states what *correct* looks like, which is not always what happens
today. There is no way to expect a consistency violation: a scenario that
reproduces a corruption declares the outcome the run should have reached and
stays red until the runtime delivers it. Six of the 39 are red for that reason.
The alternative — letting a scenario pass because the bug it documents is still
present — makes a suite that is green and a system that is broken, and gives no
signal on the day someone fixes it.

## Writers

A run is not one program. Several **writers** append to one event log, and the
log is the only thing that makes them agree:

| Writer | What it is | What it writes |
| --- | --- | --- |
| `orchestrator` | The workflow function and the runtime around it, committing at a suspension point | the run lifecycle, `step_created` / `step_started`, `hook_created`, `wait_*` |
| `step:<name>` | One step body, running inline with full Node access | its own `step_completed` / `step_failed` / `step_retrying`, and any `attr_set` it writes from step context |
| `external` | The scenario, acting as an operator or a webhook receiver | `hook_received`, `run_cancelled` |

Two step bodies in a *single* delivery are already two writers racing to the
same log: no second invocation and no real threads are required. That is why the
vocabulary is per-writer rather than per-invocation.

A script is a sequence of **advances**. Stop a writer at a named point, act
while it is stopped, let it go:

```ts
script: async (sim) => {
  const wf = sim.writer.orchestrator();
  const reserve = sim.writer.step('reserveInventory');

  // Stop just after step_started is durable and before the orchestrator is
  // resumed — the window the whole instrument exists for.
  await wf.runToEventCommitted('step_started', 'reserveInventory');
  sim.check('no payload yet', !sim.world.events().some((e) => e.eventType === 'hook_received'));
  await sim.deliverHook('approval:doc-1', { approved: true });

  // Arm the next wait BEFORE releasing: a released writer can reach the next
  // point within the same turn, and a wait armed afterwards has missed it.
  const done = reserve.runToEventCommitted('step_completed');
  await wf.release();
  await done;
  await reserve.release();
}
```

| | |
| --- | --- |
| `runToEventProduced(type, stepName?)` | Stop where the event has been decided and submitted and the log does not have it yet |
| `runToEventCommitted(type, stepName?)` | Stop where it is durable and the writer has not been resumed |
| `runToCall(call, { phase })` | The same, for a world call that is not `events.create` |
| `release()` / `isHeld()` / `history()` | Let the writer go (idempotent) / is it held / where it has been |
| `sim.writer.step(name)`, `anyStep()`, `any()`, `orchestrator()`, `seen()` | Get a handle; `seen()` lists the writers observed so far |

`runTo` is **level-triggered**: it consults the recorded history, so a point
this writer already sailed past is an `AlreadyPassedError` naming the point,
not a wait that never ends. Asking for a point twice means "the next one".
Each advance also carries its own watchdog (`limits.maxRunToWallMs`), and its
timeout reports where *every* writer was standing — a diagnosis instead of the
scenario's global budget running out.

The two mistakes worth knowing, both of which the errors name:

- **Arming too late.** Releasing writer A before arming writer B's wait. B's
  step body may already be in flight and commit during the release.
- **Waiting on the wrong writer.** `step_started` is the orchestrator's write;
  `step_completed` is the step body's. Naming the wrong one is a timeout.

Underneath, `park(match)` / `until(match)` / `during(match, body)` take a raw
match object and are what the writer handles are built from. Fields are ANDed;
`eventType` implies `events.create`, `stepName` accepts either the machine name
or the plain function name, `where(ctx, world)` covers anything the declarative
fields can't say, and `phase` defaults to `'after'`:

```ts
{ call: 'events.create' | 'queue' | 'runs.get' | … , phase: 'before' | 'after',
  eventType, stepName, correlationId, token, runId, writer, failed, where }
```

Reach for them when the point is a *state* rather than a name — `where` is the
one thing a level-triggered `runTo` cannot re-check against history, so a
`where` wait is edge-triggered and leans on its timeout.

The park/permit model — and the word *tempo* for the resulting order — is
lifted from [`blanket`](https://bernat.tech/posts/blanket-deterministic-threading/),
which does this for Python's `threading` primitives. The mapping is direct: a
world call is a transaction, the `after` phase is its parking state, and
`release()` is the permit.

A script is the only way to hang this simulator — a held call blocks its writer,
and in the limit the scheduler, so a script waiting for something that never
happens has no quiescence to fall back on. Three guards close that: the
per-advance watchdog above, the runner reporting what a script was still waiting
for instead of awaiting it forever, and a real wall-clock deadline that releases
every held call and rejects every pending wait. A script that throws is reported
as a scenario problem rather than turned into a World error, so a broken script
never gets misread as a runtime bug.

Scripts get a `ScenarioApi` alongside the writer handles:

| | |
| --- | --- |
| `deliverHook(token, payload)` | Runs the real `resumeHook()` — same code an out-of-band webhook receiver would |
| `cancelRun(reason?)` | Cancel the run under test |
| `advanceTime(ms)` | Jump the virtual clock |
| `withholdNextEvent(reads?)` | Hide the next committed event from the following event-log reads — the read hole a concurrent writer causes |
| `note(msg)` / `check(name, cond)` | Record a marker / an assertion in the trace |
| `world` | Read-only snapshot: runs, events, steps, hooks, waits, pending messages, rejected calls |

A scenario with no script at all is a control: the run plays out on the default
schedule, and the only question is whether the log it leaves reproduces it.

## What this does *not* give you

Worth being explicit, because the guarantees are narrower than "deterministic":

- **Determinism is world-level.** Step bodies are ordinary Node code. A step
  that calls `Math.random()`, reads a file, or hits the network is as
  nondeterministic here as anywhere. Keep step bodies pure, or stub them.
- **Only one interleaving per scenario.** Deliveries are serialized, so genuine
  concurrency between two in-flight invocations is not explored — a scenario
  pins *one* schedule rather than searching the space of them. (`selectNext`
  overrides which queued message goes next when the default order isn't the one
  you want.) This is the same trade `blanket` makes and states plainly: it
  *reproduces* orderings you can describe, it does not *discover* ones you
  can't. Systematic exploration and fault injection on world calls are the
  obvious next step; the call points are already the right hooks for both.
- **The store is a reimplementation, not the real thing.** It models
  `world-local`'s semantics rather than delegating to them, so in principle it
  could agree with the runtime while a real world disagrees. The strongest
  available fix is conformance testing: make the storage layer pluggable, run
  the same scenario book against `world-local`, and diff the event streams.
  That is the highest-value thing not yet built here.
- **"Before the workflow resumes" is about the log, not the CPU.** The hook is
  committed before the intercepted call returns, so it is in the log before the
  runtime's next read of it. Whether the runtime *observes* it on the very next
  replay depends on runtime optimizations (inline deltas, turbo) that can skip a
  re-read — which is itself a thing worth watching, and visible in the trace.
- **One scenario at a time per process.** The virtual clock and the World are
  process-global singletons.
- **Not a deployable World.** It has no persistence and no concurrency; it is a
  test instrument, and is intentionally not listed in `worlds-manifest.json`.
