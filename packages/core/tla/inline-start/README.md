# TLA+ model: creating a run from an inline start, with and without `run_created`

`InlineStart.tla` models how `start()` creates a run whose first orchestrator
message can be held for the sender and run inline (send-and-hold, see
`src/runtime/inline-orchestrator.ts`), and what changes when
`WORKFLOW_INLINE_SKIP_RUN_CREATED=1` skips `run_created` on a held start
(`src/runtime/start.ts`).

**What it covers:**
- one run, a workflow of one step and a hook it waits on;
- spec 9's in-band fence: the creation holds in-band position 1 and
  `run_started` position 2 in both shapes, and a refusal is a counted
  redelivery, never an ack;
- an at-least-once queue with leases. A held message is leased to the sender;
  a lapsed or crashed lease is delivered again, carrying the same `runInput`;
- `resumeHook()`: it records `hook_received` out of band, then queues a wake;
- a bounded budget of faults (`MaxFaults`):
  - the sender's process dies at any point, and takes its inline delivery with
    it;
  - a queue delivery dies;
  - a lease lapses while its holder keeps running;
  - `run_created` or an in-band write fails retryably, committed or not;
- an input that every creation refuses (`AllowInvalid`, a 400).

**`start()`:**
- `Skip = FALSE` (today): `run_created` and the held send run concurrently. A
  held message runs inline in turbo mode: no log load, the count right after
  the creation, and a `run_started` that creates the run from `runInput` if
  `run_created` hasn't landed.
- `Skip = TRUE`: the held send goes first.
  - `held`: no `run_created`. The inline delivery's `run_started` creates the
    run. `start()` returns once that write settles: success or "exists" is a
    plain success, a retryable failure or a delivery that ended first is a
    resilient start, and a permanent refusal throws.
  - `not_held`: `start()` writes `run_created`, awaited, after the answer.
  - The held send throws: it is sent again without a hold, under the same
    idempotency key, and `run_created` is written once that re-send is
    accepted (`ThrewResendFirst`). Writing it beside the re-send leaves a
    window for a run without a message (`Bug_ThrewResendBeside`).

**`Shape`** says how the World records a creating `run_started`:
- `synthetic`: a synthetic `run_created` at slot 1 and the `run_started` at
  slot 2 (today's resilient start, and any World without `createsRun`);
- `alone`: the `run_started` alone at slot 1 (`createsRun`).

## Properties

| Property | Kind | Says |
| --- | --- | --- |
| `CreatedOnce` | invariant | The run is created exactly once, at slot 1, with its input. The log never holds both a `run_created` and a creating `run_started`. |
| `ExactlyOnce` | invariant | Each in-band write, the step's commit included, is in the log at most once. |
| `CountMatches` | invariant | The in-band count is the one a log with `run_created` would have, in either shape. |
| `TimesConsistent` | invariant | The created time is the creation event's slot, and it is no later than `run_started`, which comes before the step's commit. |
| `StartContract` | invariant | A plain success from `start()` means the run exists and its input was valid. `start()` throws only for an input that can never be stored. |
| `NoStranding` | liveness | An accepted run (its message was sent) with a valid input completes, and its step commits. |
| `InvalidSettles` | liveness | A run whose input is refused never holds its message forever. |
| `NoOrphanRun` | liveness | A run that exists always gets its message. Checked by the `Skip_*`, `Probe_*` and `Bug_ThrewResendBeside` configs. |

Liveness assumes weak fairness for `start()`, queue deliveries, delivery
steps and the resume. Faults are not fair; they are bounded by `MaxFaults`.

## Configurations

| Config | Model | Expected |
| --- | --- | --- |
| `Today` | `Skip = FALSE` | holds |
| `Skip_Synthetic` | `Skip = TRUE` as implemented, World writes a synthetic `run_created` | holds, `NoOrphanRun` included |
| `Skip_Alone` | `Skip = TRUE` as implemented, World writes the `run_started` alone (`createsRun`) | holds, `NoOrphanRun` included |
| `Bug_ReturnEarly` | Seeded bug: with Skip on, `start()` returns success once the hold is held, without waiting for the creation | **violated**: `StartContract` |
| `Bug_NoInputOnRedelivery` | Seeded bug: a redelivery's `run_started` drops `runInput` | **violated**: `NoStranding` |
| `Probe_Orphan_Today` | `NoOrphanRun`, `Skip = FALSE` | **violated**: a window that exists today |
| `Bug_ThrewResendBeside` | Seeded bug: `Skip = TRUE`, but after a thrown held send `run_created` goes beside the re-send | **violated**: `NoOrphanRun` |

## Results

TLC 1.8.0, `Slots = {1, 2, 3}`, `MaxFaults = 2` (1 for `Bug_*`),
`HasHook = TRUE` (`FALSE` for `Bug_*`), run exhaustively with `-deadlock`
(a finished run is a terminal state):

| Config | Result | States generated | Distinct states | Depth |
| --- | --- | ---: | ---: | ---: |
| `Today` | holds | 888,336 | 215,504 | 26 |
| `Skip_Synthetic` | holds (`NoOrphanRun` included) | 784,631 | 190,619 | 26 |
| `Skip_Alone` | holds (`NoOrphanRun` included) | 1,072,972 | 261,875 | 26 |
| `Bug_ReturnEarly` | violated (`StartContract`, 3 steps) | 6 | 6 | 3 |
| `Bug_NoInputOnRedelivery` | violated (`NoStranding`) | 8,472 | 2,992 | 15 |
| `Bug_ThrewResendBeside` | violated (`NoOrphanRun`) | 65,433 | 23,224 | 13 |
| `Probe_Orphan_Today` | violated (`NoOrphanRun`) | 78,626 | 26,900 | 13 |

A violated temporal property stops the search, so those rows count the
states explored up to the counterexample.

`./check.sh` runs all seven configs; the liveness checks of the two `Skip_*` configs take most of the time.

## Counterexamples

- **`Bug_ReturnEarly`**: `start()` sends with a hold and gets `held`, then
  returns success. The inline delivery hasn't written `run_started`, so the
  run doesn't exist yet. A `getRun()` in another process would get a 404.
- **`Bug_NoInputOnRedelivery`**: a held start loses its sender before the
  inline `run_started` lands. The lease lapses and the queue delivers the
  message again. That delivery's `run_started` carries no input, so it gets a
  404 and is redelivered, forever. With `Skip = FALSE` the same bug is hidden
  whenever `run_created` landed. With the skip, the redelivery's `runInput` is
  the only way the run gets created after a sender crash.
- **`Probe_Orphan_Today`, `Bug_ThrewResendBeside`**: `run_created` commits, then the sender dies before the
  message is enqueued. The run stays `pending` and nothing runs it.
  - Today this window is open on every start, because the two writes run
    concurrently.
  - With the skip, it closes on `held` (no `run_created` at all) and on
    `not_held` (`run_created` comes after the enqueue). After a held send
    that throws, `start()` writes `run_created` only once the re-send is
    accepted, which closes it there too, at one round trip on that rare path.
    `Bug_ThrewResendBeside` (`run_created` beside the re-send) shows the
    window that ordering closes.

## Running

```sh
./check.sh                 # every *.cfg
./check.sh Skip_Alone.cfg  # one
```

It uses `java` if it is on the path, and Docker (`eclipse-temurin:21-jre`)
otherwise.
