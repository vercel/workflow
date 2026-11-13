# inline-step-bench

A local benchmark for **step-to-step overhead (STSO) when steps run eagerly
inline** — many sequential steps executed inside a *single* flow-handler
invocation, with no queue hop between them.

It answers three questions:

1. What does the runtime cost between two adjacent no-op steps in that regime?
2. Does the runtime really re-execute the whole workflow function, over the
   whole event log, before every single step?
3. How does the cost of the 1000th step compare to the first few?

Short answers: **~7 ms, yes, and ~10× worse.**

---

## Running it

```bash
pnpm install                  # from the repo root
pnpm --filter @workflow/inline-step-bench build     # wf build → .well-known/
pnpm --filter @workflow/inline-step-bench bench     # 1000 steps, all scenarios

# or directly, with knobs:
node bench.mjs --steps 300
node bench.mjs --only replay-profile
node bench.mjs --steps 1000 --keep-data
```

`RESULTS-1000.txt` in this directory is the full output of a 1000-step run on
the machine described at the top of that file. Per-run JSON and per-step CSVs
are written to `results/`.

A full `pnpm build` at the repo root needs Rust, because
`packages/swc-plugin-workflow` compiles its WASM transform with cargo. On a box
without cargo you can drop in the published artifact instead — it only has to
match the workspace version:

```bash
npm pack @workflow/swc-plugin@<version in packages/swc-plugin-workflow/package.json>
tar xzf workflow-swc-plugin-*.tgz
cp package/swc_plugin_workflow.wasm package/build-hash.json packages/swc-plugin-workflow/
# then skip that package's build task
```

## What's here

| file | what it is |
| --- | --- |
| `workflows/null-steps.ts` | `timedNullStepsWorkflow(n)` and `voidNullStepsWorkflow(n)` — `n` sequential steps that do nothing |
| `server.mjs` | minimal local host (trimmed copy of `packages/world-testing/src/server.mts`): mounts the generated flow route, counts flow-handler invocations per run, exposes the run output and raw event log |
| `bench.mjs` | driver: spawns the server against `@workflow/world-local`, runs the workflow, computes STSO, and parses the runtime's own debug log for per-replay timings |

## Method

`timedNullStepsWorkflow(n)` is a `"use workflow"` function that awaits `n`
sequential `"use step"` calls. Each step body does nothing except stamp
`performance.now()` on entry and exit. Step bodies run in Node (not in the
workflow VM), so those clocks are real.

```
STSO[i] = t0[i] − t1[i−1]
```

i.e. the wall-clock between the end of one step body and the start of the next.
The bodies are empty, so **that gap is the runtime overhead** and nothing else:

- append the previous step's `step_completed` to the event log,
- load the new events,
- build a fresh workflow VM context,
- **replay the workflow function from the top against the entire event log**,
- reach the next `await`, write `step_started` for the next step,
- run its body.

Timings are also reconstructed independently from the event log
(`step_started` / `step_completed` `createdAt`) for the `void` variant, which
returns nothing at all, as a control against the sample array the timed variant
accumulates.

Two env vars are raised so the whole chain stays in one invocation:
`WORKFLOW_V2_TIMEOUT_MS` (default 120 s of wall time) and
`WORKFLOW_REPLAY_TIMEOUT_MS` (default 240 s of non-step time). At 1000 steps on
world-local the run finishes in ~44 s, so the defaults would not have forced a
hop anyway. Extrapolating the quadratic fit below, the 120 s wall-clock limit
would bind at roughly 1700 steps — after which the chain *does* start paying
queue hops.

### Caveats

- **`@workflow/world-local` is a filesystem world.** Its per-event cost (one
  JSON file per event, plus a `readdir`-backed cursor query) is not Vercel's
  network cost. The *fixed* per-step term here is therefore not a prediction of
  production latency. The *replay* term is CPU work that is identical wherever
  it runs.
- `performance.now()` is meaningful across steps because everything happens in
  one process. Event-log timestamps are `Date.now()`, i.e. 1 ms granularity.
- The `replay-profile*` scenarios enable `DEBUG=workflow:runtime:debug`. The
  logging itself inflates STSO by roughly 5–10%, so the absolute STSO numbers
  should be read off `turbo-on`; the replay decomposition should be read off
  `replay-profile`.

---

## Results (1000 null steps, world-local, 16-core Xeon @ 2.9 GHz, node 22)

### 1. Every step really does replay every prior step

```
flow-handler invocations for this run : 1  ✓ entire chain ran eagerly in ONE invocation
events in the log                     : 3003 (3.00 per step)
  {"run_created":1,"run_started":1,"step_started":1000,"step_created":1000,"step_completed":1000,"run_completed":1}
step bodies executed                  : 1000 (each exactly once)

runtime replay log: 1001 in-process loop iterations
  ✓ 1000 step-scheduling replays + 1 final replay that ran the workflow to completion
```

One invocation, no queue hop between steps, 1000 step bodies — and **1001 executions of
the workflow function**. Each one re-runs the loop from `i = 0` and re-consumes
the whole event log, which by then holds 3 events per completed step:

```
  iterations   events@end   mean replayMs   max replayMs
  ────────────  ───────────  ──────────────  ─────────────
       1–100          299            6.15           9.00
     101–200          599           11.62          16.00
     201–300          899           18.19          24.00
     301–400         1199           25.68          50.00
     401–500         1499           30.74          36.00
     501–600         1799           37.86          61.00
     601–700         2099           45.71          69.00
     701–800         2399           51.91          84.00
     801–900         2699           58.04          73.00
    901–1000         2999           65.95          101.00
   1001–1001         3002          120.00          120.00
```

`replayMs` is the runtime's own measurement: from just before `runWorkflow()` to
the moment the suspension for the next step is caught. No world I/O, no step
body — pure replay. It rises **from ~6 ms to ~66 ms**, linear in event count:

```
replayMs ≈ 1.75 + 0.022 × eventCount     (≈ 0.067 ms per already-completed step)
Σ replayMs = 35 305 ms out of a 45 032 ms run
```

This is by design, not a bug. `packages/core/src/runtime.ts` runs a
`while (true)` loop whose body calls `runWorkflow(workflowCode, workflowRun,
events, …)` with the *full* event array, and `packages/core/src/vm/script-cache.ts`
says it outright:

> Replaying a workflow re-evaluates the workflow bundle against a fresh VM
> context on every iteration of the inline replay loop […] O(N) full re-parses
> for a sequential workflow of N steps

(The compiled `vm.Script` is cached across replays; the *context* and the
*event replay* are not.)

### 2. Step-to-step overhead vs. step index

`turbo-on`, the shipped default config:

```
      steps      n      mean       p50       p90       min       max
───────────  ─────  ────────  ────────  ────────  ────────  ────────
        1–1      1     14.00     14.00     14.00     14.00     14.00
       2–10      9      8.32      8.06      9.09      7.51     10.53
      11–50     40      9.99      9.86     11.56      8.38     12.16
     51–100     50     12.90     12.72     14.06     10.82     22.66
    101–200    100     19.05     18.99     23.43     13.24     28.25
    201–300    100     25.71     25.37     28.87     20.45     45.16
    301–400    100     33.36     32.26     37.36     26.46     52.48
    401–500    100     41.11     40.03     45.15     34.16     68.53
    501–600    100     47.96     47.92     51.68     42.06     78.91
    601–700    100     55.10     54.08     58.13     49.00     81.27
    701–800    100     61.56     61.55     65.83     54.46     71.26
    801–900    100     69.89     69.08     75.81     63.32    100.11
    901–999     99     80.08     77.68     89.15     72.51    140.93
```

- **first few steps: ~8 ms**
- **around step 1000: ~80 ms**
- **ratio: ~10×**

```
STSO(i) ≈ 7.3 ms + 0.074 ms × i
```

The fit is the whole story:

- **7.3 ms fixed** — two world writes (`step_started` carrying the input, which
  the world turns into a synthetic `step_created` + `step_started`, then
  `step_completed`) plus suspension bookkeeping and a fresh VM context. On
  world-local this is filesystem cost; on Vercel it is two network round-trips.
- **0.074 ms × i marginal** — replaying the `i` steps already in the log.

Total wall time is therefore **quadratic in step count**: 1000 null steps take
**44 s**, of which 35 s is replay and ~1 ms is actual step-body work.

### 3. Where the gap goes

`replay-profile` splits each gap into replay vs everything-else:

```
      steps       gap    replay     other   replay%
───────────  ────────  ────────  ────────  ────────
        1–1      8.90      2.00      6.90     22.48
       2–10      7.36      3.11      4.25     42.25
      11–50     10.30      5.25      5.05     50.95
     51–100     12.75      7.52      5.23     58.99
    101–200     17.56     11.68      5.88     66.50
    201–300     25.30     18.26      7.04     72.17
    301–400     34.46     25.76      8.70     74.76
    401–500     39.57     30.79      8.78     77.80
    501–600     47.86     37.94      9.92     79.28
    601–700     56.96     45.77     11.19     80.35
    701–800     65.03     51.95     13.08     79.88
    801–900     71.98     58.11     13.87     80.73
    901–999     81.14     66.02     15.12     81.36
```

Replay overtakes world I/O at roughly **step 15–20** and is **~80% of the gap**
past step 300. (`other` also drifts up, 4 ms → 15 ms; that part is a
world-local artifact — its inline-delta cursor query does a `readdir` over a
directory that now holds 3000 event files. A network world would keep that term
roughly flat.)

### 4. The step's return value doubles the slope — but *not* because of its size

`void-steps` runs the identical chain with steps that return `undefined`:

```
            scenario   invocations   STSO 1–10   STSO last10    growth   fixed ms    ms/step    total ms
────────────────────  ────────────  ──────────  ────────────  ────────  ─────────  ─────────  ──────────
            turbo-on             1        8.89         87.78     9.88x      7.309      0.074    44437.27
           turbo-off             1        7.90         79.48    10.06x      5.551      0.077    43768.78
          void-steps             1        5.50         33.80     6.15x      4.412      0.029    21230.00
      replay-profile             1        7.52         85.77    11.41x      6.121      0.078    45031.89
 replay-profile-void             1        5.30         36.50     6.89x      4.561      0.032    22597.00
```

Dropping a four-field object from each step's return value halves the marginal
cost (0.074 → 0.029 ms per prior step) and the total run (44 s → 21 s).

The obvious reading — "bigger payloads cost more to re-deserialize" — is wrong.
`node bench.mjs --suite payload` (full output in `RESULTS-payload-600.txt`) runs
six identical 600-step chains that differ only in what the step returns:

```
            scenario   STSO 1–10   STSO last10    growth   fixed ms    ms/step    total ms
────────────────────  ──────────  ────────────  ────────  ─────────  ─────────  ──────────
                void        5.60         22.20     3.96x      5.453      0.028     9964.00
              number        5.00         20.90     4.18x      4.818      0.028     9325.00
             str4000        5.20         21.60     4.15x      4.804      0.028     9469.00
             str5000        6.40         47.90     7.48x      4.817      0.074    17766.00
                obj4        5.40         48.60     9.00x      3.213      0.072    16423.00
               obj40        5.20         49.30     9.48x      4.549      0.077    18107.00
```

| returns | payload | slope ms/step |
| --- | --- | --- |
| `undefined` | 0 B | 0.028 |
| a number | ~1 B | 0.028 |
| **a 4000-char string** | **4 KB** | **0.028** |
| **a 5000-char string** | **5 KB** | **0.074** |
| a 4-field object | ~40 B | 0.072 |
| a 40-field object | ~600 B | 0.077 |

Read those pairs carefully:

- A **4 KB string is exactly as cheap as returning nothing.**
- Making that string **25% longer** (4000 → 5000 chars) **multiplies the slope
  by 2.6×.**
- A **40-byte object costs the same as a 5 KB string** — 100× less data, same
  price.
- **15× the object payload** (obj4 → obj40) moves the slope by **7%**.

Size is nearly irrelevant. The step function is 4096.

### Why: the cache can memoize primitives but not object graphs

The event log *is* fully in memory, and so are the payload bytes. What can't be
reused across replays is the **deserialized value**, because
`packages/core/src/workflow.ts` builds a **fresh VM context per replay** and an
object minted in one realm can't be handed to the next — its prototypes, its
revived `Workflow` objects, step proxies, streams, and registered class
instances all belong to the old realm's globals.

`packages/core/src/replay-payload-cache.ts` splits the work along exactly that
line:

> This cache keeps the VM-independent decrypt/decompress result across those
> replays. **Deserialization still runs against each VM's globals** so every
> replay receives fresh object graphs and correctly revived Workflow objects.

So decrypt/decompress *is* cached (`preparedPayloads`), and on top of that there
is a second cache for final values — with a guard:

```ts
async getStepResult(eventId, hydrate) {
  if (this.primitiveStepResults.has(eventId)) return this.primitiveStepResults.get(eventId);
  const value = await hydrate();
  if (isMemoizablePrimitive(value)) this.primitiveStepResults.set(eventId, value);
  return value;
}
```

`isMemoizablePrimitive` is "not an object or function, and — for strings and
bigints — no longer than `MAX_MEMOIZED_PRIMITIVE_LENGTH = 4096`". Sharing a
primitive between realms is unobservable, so it's safe to memoize; the 4096 cap
bounds how much the memo table can pin for the invocation's lifetime. That
constant is the cliff the benchmark walks off between `str4000` and `str5000`.

On a miss, `step.ts:299` re-runs the full hydrate for that step, on every
replay, via `deserializePreparedReplayPayload`:

```ts
return workflowModule.deserialize(prepared.data, {
  global,
  extraRevivers: { ...getStreamAndRequestRevivers(getWorkflowRevivers(global)), ...extraRevivers },
});
```

`getWorkflowRevivers(global)` is not a constant — it *constructs* a table of
closures on every call (`{...getClassRevivers(global), ...getCommonReviversFromModule(global),
...getStepFunctionReviver(global), Request: …, WorkflowFunction: …}`), then
`getStreamAndRequestRevivers` builds another, then two more object spreads. All
of that is bound to `global`, so it can't be hoisted out of the per-replay,
per-step loop as long as the realm keeps changing.

That explains the shape of the data: the ~0.045 ms/step penalty for an
unmemoizable value is **mostly fixed per-hydration setup**, not decoding. If it
were decoding, obj40 would cost ~15× obj4; it costs 7% more.

### 5. Turbo mode is not what's driving this

`WORKFLOW_TURBO=0` leaves the slope alone (0.074 vs 0.077 ms per prior step) and
moves the fixed term by less than run-to-run variance — across two full runs the
turbo-on/turbo-off intercepts came out 7.31/5.55 and 6.23/6.98 ms, i.e. the sign
flipped. That is expected here: turbo's per-step effect is forcing optimistic
inline start (running the body without awaiting `step_started`), and on
world-local that write is sub-millisecond. On a network world it would be a full
round-trip per step and would show. Turbo's real job is removing *start-up*
round-trips on the first delivery; it does not touch the replay loop. See
`docs/content/docs/v5/changelog/turbo-mode.md`, which also records the
deliberate decision *not* to run ahead of durable writes ("run-ahead") and why.

---

## Takeaways

- In the eager-inline regime the floor is **two world round-trips plus one full
  replay per step**. Locally that floor is ~7 ms; on Vercel the fixed part is
  network-bound and larger, but the replay part is the same CPU work.
- Replay cost is **O(events in the log)** per step, so a sequential chain is
  **O(N²)** overall. At N = 1000 the last step pays ~10× the first.
- The practical knee is where replay overtakes the fixed cost. Locally that is
  ~step 15–20.
- **A step's return value doubles the per-step replay slope when it is not a
  memoizable primitive — and payload size barely matters.** `undefined`, a
  number, and a 4000-char string are all 0.028 ms/step; a 4001-char string, a
  40-byte object, and a 600-byte object are all ~0.075. Returning a small
  object is *more* expensive than returning 4 KB of string.
- Anything that shrinks the replayed log helps super-linearly: fewer/larger
  steps, or splitting a long chain across child workflows. Shrinking a return
  value only helps if it crosses back over the memoizable-primitive line.
