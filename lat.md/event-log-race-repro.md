# Event log race repro

[[packages/core/e2e/event-log-race-repro.test.ts|`packages/core/e2e/event-log-race-repro.test.ts`]] is a dedicated harness for
`CORRUPTED_EVENT_LOG`.

It drives six scenarios against one deployment:
`step-storm` and `hook-storm` (concurrent replays of a single run racing the
per-branch watchdog; `hook-storm` is a production shape), `blocked-branch`
(each branch parks on a launch step before its hook race, so a woken replay can
hold a log that predates a sibling's launch completion and take the ordinal that
sibling's wait is about to get; it covers the class the wake-order fixes miss),
`wake-loop` (one sequential loop racing a reusable hook read against a
heartbeat sleep, no fan-out; the driver supplies the concurrency with bursty
resumes and resumes aimed at the heartbeat deadline, the shape of a production
run whose replays of one immutable prefix diverged non-deterministically on an
unconsumable `wait_created`), `dag-runner` (a ready-set scheduler over a fixed
DAG, width above the inline step limit so waves mix inline and dispatched
steps, whose worker nodes bind a hook and await `hook.getConflict()` mid-fan-out;
it needs no racing driver, only worker callbacks, and is the shape of a
production runner whose single-writer logs failed to replay), plus a
`hook-sleep` control that provides the calibration baseline. Any outcome
other than `completed` fails the run, except `infra`, which means the harness
could not reach the deployment.

Run it against a locally started workbench app. No Vercel deployment or
credentials are required:

```bash
pnpm run test:e2e:event-log-race-repro:local              # world-postgres
pnpm run test:e2e:event-log-race-repro:local --world local # world-local
```

The script ([[scripts/event-log-race-repro-local.sh|`scripts/event-log-race-repro-local.sh`]], `--help` for flags) builds
and starts [[workbench/nextjs-turbopack|`workbench/nextjs-turbopack`]] with `WORKFLOW_TARGET_WORLD` and
`WORKFLOW_PUBLIC_MANIFEST=1` set **at build time** (both are build-time inputs;
missing either silently yields a default-world app or a 404 manifest), runs the
harness, prints the same summary table CI posts, and tears the server down. For
world-postgres it first brings up the container and applies migrations, and
leaves Postgres running for the next iteration unless `--teardown` is passed;
the container flags (`--skip-db-setup`, `--no-docker`, `--teardown`) do nothing
under `--world local`, whose only state is a data directory the script clears
before each run. Under `--world local` it also exports `WORKFLOW_QUEUE_AUTH=off`,
as the e2e-local CI lanes do until the team decides to run them with queue auth
on. world-postgres needs no such setting: it declares
`queueAuthMode: 'skip'`, so its flow route is not checked.

Run both worlds because neither subsumes the other: world-postgres
arbitrates event slots inside one SQL statement, while world-local arbitrates
them with an exclusive `link(2)` against a directory that two processes (the app
and the harness) both write to. A slot race a transaction closes is not
automatically closed by a filesystem.

Both worlds race the single orchestrator (spec 10) by default; export
`WORKFLOW_SPEC_VERSION=8` to race the spec 8 one. CI runs both worlds at the
default spec and at spec 8. Read the world-local default (spec 10) cell with
one difference in mind: its run gate is in-process, and the harness calls
`start()` and `resumeHook()` from its own process, so those messages reach the
app through the harness' queue and overlap the app's own deliveries of the run.
The in-band fence refuses each overlap (logged as "keep being refused by the
in-band fence"), so the run stays correct but slower: on a 4-core box,
`hook-storm` took about 300s a run at spec 9 against 150s at spec 8, and the
same two-run `step-storm` logged 60 refusals on world-local and none on
world-postgres, whose named queue gates across processes.

Scale is controlled entirely by `EVENT_LOG_RACE_REPRO_*` environment variables.
Their defaults live only in [[packages/core/e2e/event-log-race-repro.test.ts|`event-log-race-repro.test.ts`]]; neither the CI
workflow nor the local script defines a second copy. The default scale
is a per-PR regression check, not a rate measurement; a clean run means "the
storms did not trip it", not "the rate is below X". To soak for a *rate*, use the
historical scale:

```bash
EVENT_LOG_RACE_REPRO_STEP_STORM_ATTEMPTS=600 \
EVENT_LOG_RACE_REPRO_HOOK_STORM_ATTEMPTS=600 \
EVENT_LOG_RACE_REPRO_ATTEMPTS=200 \
EVENT_LOG_RACE_REPRO_CONCURRENCY=40 \
EVENT_LOG_RACE_REPRO_BUDGET_MS=4500000 \
  pnpm run test:e2e:event-log-race-repro:local --skip-build --skip-db-setup
```

The measurements below used 14 runs; they are historical calibration data, not the current default scale.

Against world-postgres the storms bite much harder than the CI job's Vercel
preview does: on `main`, three 14-run passes failed 8 of their 18 `step-storm`
attempts with `CORRUPTED_EVENT_LOG` while `hook-storm` and `hook-sleep` stayed
clean, so the script exits non-zero. That is the harness working, not a broken
setup, and it is why the local runner is the fast signal while a fix is in
flight. At 14 runs, a green CI job means "the storms did not trip it", nowhere
near "the rate is below X".

That is a *laptop* result, and the distinction matters: `CORRUPTED_EVENT_LOG`
means the run finished the race, while `stuck` usually means it never got to
run one. Two dispatches of the local lanes against unmodified `main` on GitHub's
4-core runners scored, at that scale, world-postgres 5-6 of 6 `step-storm`
runs `stuck` at `runTimeoutMs` in both, and world-local 6 and 12 of 14 `stuck`.
The *same* lane, the same commit, "6/14" and "12/14" one dispatch apart. Read a
single local-lane number as a verdict on a PR and it will mislead you; read
`pressure.resumesSent` and `progress.events` in the results JSON instead, which
say whether the run was racing or starving.

Two properties of the harness made that starvation self-sustaining, and both are
now bounded. If you change either, know what you are giving up:

* **The poke pump decays** (`EVENT_LOG_RACE_REPRO_POKE_MAX`, default 64, then
  `POKE_DECAY_FACTOR`, default 8). `step-storm`'s pressure is a wall-clock
  cadence, so a slow run collected *more* out-of-band writes per unit of progress
  than a fast one, and each one appends a `hook_received` that every later replay
  re-reads. Unbounded on a 4-core runner it reached approximately 270 pokes per
  run and no run ever finished. A healthy 6-round run sends 35-41 and never
  reaches the budget. The pump slows rather than stopping, so a saturated run's
  later rounds still get out-of-band writes; a hard stop left the back half of a
  160s CI run unpressured. The lanes were never comparable on this axis anyway:
  each Vercel resume pays a network round trip, so that lane's pump achieves an
  effective 2.3s interval (35-44 pokes per run) where localhost runs the full
  750ms, and the decayed rate is what brings the local lanes near it.
* **Runs abandoned at `runTimeoutMs` are canceled.** They used to keep replaying
  in the same app process for the rest of the job. That is how world-local's
  `hook-storm` came to report six `stuck` runs with `resumesSent: 0`. Every one
  of them starved behind the previous scenario's six abandoned `step-storm` runs
  and never created a hook for the driver to resume, so the scenario measured
  nothing about hooks at all.

The local script also raises `EVENT_LOG_RACE_REPRO_RUN_TIMEOUT_MS` to 480000
(export your own to override). A local lane runs the same storm about twice as
slowly as the Vercel lane. Measured on 4-core runners at that scale,
`step-storm` takes 194-203s on world-local and 168-175s on world-postgres
against Vercel's 85-100s, so the harness' 240000 default left the local lanes at
approximately 83% of their own timeout, close enough that a slow runner turns a
lane that reproduces into a lane full of `stuck`. It is the one scale knob the
script sets, because it is the one whose meaning depends on everything sharing a
process.

One difference affects how you read a local result: in CI each replay gets its
own Fluid invocation, while here every replay
of every run shares one Next.js process. world-postgres gives that process (and
the harness process) 50 embedded Graphile Worker slots each, and approximately
100 replays in one heap saturates GC. Measured on a 12-core laptop, all 14
attempts came back
`stuck` with the server at 6.4 GB RSS and Postgres idle. The script therefore
sets `WORKFLOW_POSTGRES_WORKER_CONCURRENCY=10` (override by exporting it) and
raises the app's old-space limit (`--heap-mb`). If a local run reports `stuck`
rather than `CORRUPTED_EVENT_LOG`, suspect the machine before the SDK.
world-local saturates the same single process from its own in-process queue,
which defaults to 1,000 deliveries in flight, so the script holds it at the same
number via `WORKFLOW_LOCAL_QUEUE_CONCURRENCY`.

What the local lanes are *not* is a throughput bug in the two Worlds. Under
saturation world-local logged zero failed deliveries, zero handler errors and
zero exhausted messages across three 14-run passes: its semaphore parks a
message *before* the delivery fetch, so queue waiting never consumes the
transport timeout and there is no retry amplification to find. It is a bounded
FIFO doing what it says, and the ceiling it hits is one Node process serving
what the Vercel lane spreads across Fluid instances. Two things about these
Worlds are nonetheless worth fixing on their own merits, and neither is what
made the lanes red: world-local defaults to **1000** in-flight deliveries (the
comment above it says the limit exists to avoid overwhelming the process, and
the repro script has to override it to 10), world-postgres to 50 embedded
workers *per process*; and neither World serializes a spec 8 run's replays,
so a run's concurrent wakes each replay the whole log.

world-local's storms come out clean far more often than world-postgres's, so the
default scale says even less there: the corruption it does produce needs a
`hook_received` to be staged and then rejected, which the harness reaches only
in a run's terminal moments. Reach for a unit test in
[[packages/world-local/src/storage/|`packages/world-local/src/storage/`]] when a suspected filesystem race can be
staged directly. It costs milliseconds and does not depend on the interleaving
showing up.

In CI the same harness runs from [[.github/workflows/event-log-race-repro.yml|`.github/workflows/event-log-race-repro.yml`]],
triggered by adding the `event-log-race-repro` label to a PR or by
`workflow_dispatch`, whose inputs are the soak dial. Raise `timeout-minutes` in
that dispatch's branch if you raise `budget_ms`. Alongside the Vercel lane, the
workflow runs the local script against world-local and world-postgres as
parallel lanes. Those two lanes are report-only because the local storms have red
baselines at the default scale (see above), so they publish numbers rather than a
verdict and fail only when the harness produced no result file at all; the Vercel
lane remains the gate.

All three lanes land in one sticky PR comment, rendered from their artifacts by
the `event-log-race-repro-comment` job: a verdict line per lane, then a history
table of one row per lane per run (total / complete / corrupt / stuck / other),
then the latest run's non-completed runs with links. Each lane's own job summary
carries the same tables for that lane alone. The comment keeps the last few runs;
older ones stay in the jobs' artifacts, which hold the full results JSON.

To poke at a run afterwards, the CLI reads the same world from the environment:

```bash
WORKFLOW_TARGET_WORLD=@workflow/world-postgres \
WORKFLOW_POSTGRES_URL=postgres://world:world@localhost:5432/world \
  pnpm wf inspect <run-id>

WORKFLOW_TARGET_WORLD=local \
WORKFLOW_LOCAL_DATA_DIR=workbench/nextjs-turbopack/.next/workflow-data \
  pnpm wf inspect <run-id>
```
