# Benchmark variance analysis

_Analysis date: 2026-07-30. Data: twelve CI benchmark runs of `nextjs-turbopack`
on the `vercel` backend, methodology version 2, spanning both the preview
(PR) and production (`main`) environments._

This documents where run-to-run variance in the Performance Benchmarks job
actually comes from, measured against real CI data rather than inferred. It
exists because the benchmark comment was reporting large deltas — up to +523%
— on changes that could not possibly have caused them, which made the whole
report easy to dismiss.

Two headline results:

1. **The measurement is precise, but each run measures a different deployment**,
   and deployments differ from each other by more than most real regressions
   would. This holds in production as much as in preview: two `main` runs twelve
   minutes apart, differing only by a lint-only commit, came out 13% apart.
2. **The inline/queue-hop split has a blind spot.** It tags by *process*
   identity, so a queue-hop onto a *reused warm* process is silently counted as
   an inline step. Affected runs carry multi-second samples inside the inline
   population.

## Detection floor (the practical takeaway)

Measured across six preview runs of **byte-identical runtime code** and three
consecutive production runs. A delta smaller than this is not evidence of
anything.

| Signal | Null spread | Verdict |
|---|---|---|
| inline STSO — cumulative / mean | sd ≈ 5% of mean; **observed range 13%** | treat ±10% as the floor |
| inline STSO — p99 | 661-835 ms (±12%) | the ±15% 🔻 threshold is barely above noise |
| inline STSO — tail count (>700 ms) | 8-28 samples | do not gate on it |
| queue-hop STSO — count | **always 3 actual; 0 or 3 reported** | see finding 3; currently unreliable |
| queue-hop STSO — per-hop cost | 1545-4663 ms (n≤3/run) | too few samples to read |
| TTFS — p50 | ±3% within an environment | usable; see the environment bias in finding 5 |
| TTFS — Best | 0-17 fast samples out of 30 | not a usable signal |

For scale: a branch with a genuine regression (`pgp/replay-engine-determinism-tests`,
22:15) measured an inline mean of **1361 ms against a null mean of 388 ms** —
3.5×. The metric detects real regressions comfortably; it is the sub-15% range
where it cannot be trusted.

## Dataset

All runs execute the same workload: `benchSequentialStepsWorkflow(1020)`, one
iteration, yielding 1019 STSO samples split between the two populations.

**Production (`main`), consecutive merges:**

| When (UTC) | Commit | What landed | CI run |
|---|---|---|---|
| 20:38 | `8bda7ce` | #3213 — the inline/queue-hop split itself | [30580048090](https://github.com/vercel/workflow/actions/runs/30580048090) |
| 22:20 | `4a9d26b` | #3186 — persist compute instance per step attempt | [30586783627](https://github.com/vercel/workflow/actions/runs/30586783627) |
| 22:32 | `32ac8e7` | #3222 — Biome lint fixes (semantically neutral) | [30587485157](https://github.com/vercel/workflow/actions/runs/30587485157) |

**Preview (PRs) with runtime code byte-identical to `8bda7ce`** — the null set:

| When (UTC) | PR | Why it is runtime-identical | CI run |
|---|---|---|---|
| 18:30 | #3213 | later commits touched only the comment renderer | [30570697187](https://github.com/vercel/workflow/actions/runs/30570697187) |
| 18:58 | #3213 | " | [30572791924](https://github.com/vercel/workflow/actions/runs/30572791924) |
| 19:34 | #3213 | " | [30575442330](https://github.com/vercel/workflow/actions/runs/30575442330) |
| 21:30 | #3101 | adds one `// NO-OP` comment line | [30582183243](https://github.com/vercel/workflow/actions/runs/30582183243) |
| 22:07 | #3236 | documentation only | [30586031837](https://github.com/vercel/workflow/actions/runs/30586031837) |
| 22:30 | #3170 | `docs/` app only (35 files, no runtime) | [30587369865](https://github.com/vercel/workflow/actions/runs/30587369865) |

**Preview runs with real code changes** (context only, not part of the null set):
#3238 `pgp/bisect-3198-only` ([30588202433](https://github.com/vercel/workflow/actions/runs/30588202433)),
`pgp/replay-engine-determinism-tests` ([30586473644](https://github.com/vercel/workflow/actions/runs/30586473644)).

## The data

```
run                            n   cum(s)  mean   p50   p90   p99  tail>700 body<=700 | TTFS p50 fast/30 | hops
PROD  8bda7ce 20:38  #3213  1016    408.2   402   406   535   684        8      398   |    1039   6/30  |  3
PROD  4a9d26b 22:20  #3186  1016    388.5   382   381   522   661        8      379   |     966   0/30  |  3
PROD  32ac8e7 22:32  #3222  1016    440.4   433   422   575   808       28      417   |    1063   0/30  |  3
prev  #3213 18:30           1016    386.0   380   378   515   743       12      374   |    1300   0/30  |  3
prev  #3213 18:58           1016    386.8   381   376   517   731       15      374   |    1304   0/30  |  3
prev  #3213 19:34           1016    416.7   410   409   554   736       16      404   |    1308  11/30  |  3
prev  #3101 21:30           1016    392.4   386   365   531   790       23      375   |    1340   0/30  |  3
prev  #3236 22:07           1016    419.2   413   389   559   835       19      389   |    1384   0/30  |  3
prev  #3170 22:30           1019    367.2   360   353   484   672        8      352   |    1240   0/30  |  0
--- real code changes, for scale ---
prev  #3238 22:44           1019    413.4   406   400   547   715       15      396   |     586  17/30  |  0
prev  repl-det 22:15        1019   1387.4  1361  1379  2226  3276      799      450   |    1247   0/30  |  0
```

Summary statistics over the null sets:

```
PREVIEW, runtime-identical (n=6)
  cumulative : min 367.2  max 419.2  mean 394.7  sd 19.9  (CV 5.0%)  range 13.2%
  mean       : min 360.3  max 412.6  mean 388.3  sd 19.9  (CV 5.1%)  range 13.5%
PRODUCTION main-to-main (n=3)
  cumulative : min 388.5  max 440.4  mean 412.4  sd 26.2  (CV 6.3%)  range 12.6%
```

## Findings

### 1. The measurement is precise; the deployments are not

The 18:30 and 18:58 runs — separate preview deployments, separate 1020-step
executions — agree to **0.2%** on cumulative inline time (386.0 s vs 386.8 s)
and **0.3%** on body mean. A 1016-sample run is a stable instrument.

So the between-run differences are not sampling noise. They are real differences
between the deployments being measured. Some deployments land slow and stay slow
for the whole run: the 19:34 run sits to the right at *every* quantile (p10 257
vs ~236, p50 409 vs ~377), not just in the tail.

### 2. Production is no more stable than preview

The `main`-to-`main` comparison, which controls for the environment entirely:

```
20:38  8bda7ce  408.2 s
22:20  4a9d26b  388.5 s
22:32  32ac8e7  440.4 s
```

The last two are **twelve minutes apart** and differ only by #3222, a Biome
lint-fix commit with no semantic change — yet they are **13% apart**. The
production null spread (12.6%) matches the preview one (13.2%).

This is the cleanest available demonstration that the variance is a property of
the deployment/infrastructure draw, not of the environment tier or of anything
in the diff.

### 3. The queue-hop tag has a blind spot: warm-process reuse

`97_bench.ts` tags a step `queue-hop` when it is the first step body executed in
its **process** (module-global `hasExecutedStepInProcess`). But Vercel can serve
the follow-up invocation on the *same warm instance*, in which case the module
global is already `true` and a genuine hop is tagged `inline`.

The evidence: runs reporting **zero** hops still contain exactly three
multi-second samples in the inline population, and a run reporting three hops
contained two more:

```
#3170  (0 hops reported):  ... 750, 791, 792, 1630, 2851, 3408
#3238  (0 hops reported):  ... 812, 819, 857, 1700, 2503, 2589
32ac8e7 (3 hops reported): ... 1152, 1216, 1318, 1346, 2064, 3663
```

The number of boundaries is not a matter of opinion: an invocation is capped at
~120 s, so a run of duration `WO` must cross `ceil(WO / 120s) - 1` of them. For
every run here except the broken `repl-det` branch that is **exactly 3**.
Detection, however, is all-or-nothing — 3 of 3, or 0 of 3, never in between:

| Run | WO | boundaries required | reported hops | inline >1.5 s |
|---|---:|---:|---:|---:|
| PROD 8bda7ce | 416 s | 3 | 3 | 0 |
| PROD 4a9d26b | 397 s | 3 | 3 | 0 |
| PROD 32ac8e7 | 451 s | 3 | 3 | 2 (2064, 3663) |
| #3213 ×3, #3101 | 396-423 s | 3 | 3 | 0 |
| #3236 | 429 s | 3 | 3 | 4 (4263-4752) |
| #3170 | 368 s | 3 | **0** | 3 (1630, 2851, 3408) |
| #3238 | 414 s | 3 | **0** | 3 (1700, 2503, 2589) |
| repl-det | 1389 s | **11** | **0** | 455 (branch is broken) |

Note what this does *not* say. Where all 3 hops were detected, extra inline
samples above 1.5 s are **genuine multi-second stalls, not mislabeled hops** —
32ac8e7's two and #3236's four are real. The >1.5 s heuristic is only a reliable
hop-finder on runs that reported none.

The all-or-nothing pattern is itself informative: a per-boundary coin flip would
produce 1-of-3 and 2-of-3 runs constantly, and none appear in eleven runs. It
looks like a per-run property — whether that deployment had a warm instance
available for the run's whole duration.

Consequences:

- On affected runs the inline population absorbs three multi-second samples
  (~1.6-3.4 s each, ~8 s total), and the queue-hop row vanishes entirely.
- Removing all samples >1.5 s does **not** tighten the null spread (14.7% vs
  13.5%), so mislabeling is a second, independent contaminant rather than the
  main driver of run-to-run variance.
- The hypothesis is warm-instance reuse but has **not been directly observed**.
  It is consistent with the documented Fluid behavior, with the boundary
  arithmetic, and with the magnitude of the orphaned samples — but the decisive
  test is below.

No clean fix is available in the workflow alone. `COMPUTE_INSTANCE_ID`
(`packages/core/src/runtime/compute-instance.ts`) has exactly the same blind
spot by construction — its own docstring notes it is "shared by every invocation
it handles." The only invocation-scoped identifier in the tree is
`requestIdStorage` (keyed on `x-vercel-id`) in `packages/world-vercel/src/queue.ts`,
which step bodies cannot currently see. See open item 1.

**How to confirm it directly.** #3186 (landed 22:20) persists the compute
instance that ran each step attempt, and #2989 emits it as the OTEL
`faas.instance` span attribute. Take one run that reported 3 hops and one that
reported 0, and group their step attempts by instance id: warm reuse predicts
the 0-hop run shows a single `cinst_` across all 1020 attempts while the 3-hop
run shows four. That settles it without any new instrumentation.

### 4. Body and tail are separate signals that move independently

For PR #3101 vs the `main` baseline, the comment flagged `P99 +15% 🔻` — but:

- body (≤700 ms, ~98% of samples): mean 375 vs 398, i.e. **6% faster**
- tail (>700 ms): 23 samples vs 8, total 19.7 s vs 6.7 s
- cumulative: −4%, which is a −29 s body improvement plus a +13 s tail regression

**The 🔻 was driven by 15 samples out of 1016.** Across the full cohort the tail
count ranges 8-28, so the flag was "fat tail vs the cohort-minimum tail," not a
change in step cost.

Whether the remaining tail is concentrated late in the run (growing event log)
or scattered is **still untestable** — see open item 2.

### 5. TTFS is bimodal, and the environments differ

Mode occupancy is close to random. How many of a run's 30 TTFS samples land in
the fast mode (~200-400 ms, the in-process fast path) rather than the slow one
(~1300 ms):

```
production: 6/30,  0/30,  0/30
preview:    0/30,  0/30, 11/30, 0/30, 0/30, 0/30   (and 17/30 on #3238)
```

Because **Best is a min over 30 samples**, one lucky sample moves it 5×. That is
the mechanism behind `+523% 🔻` on a no-op change. Best is not a usable
regression signal in its current form; the fast-mode *fraction* would be.

Median TTFS, by contrast, is stable within an environment and **systematically
different between them**:

```
TTFS(step) p50:  production 966, 1039, 1063   |   preview 1240, 1300, 1304, 1308, 1340, 1384
```

Since `main` runs against production and every PR runs against preview
(`environment: ${{ github.ref == 'refs/heads/main' && 'production' || 'preview' }}`,
`.github/workflows/benchmarks.yml`), **every PR carries a built-in ~25% TTFS
"regression" that is pure environment mismatch.** This is the one finding where
the environment split genuinely matters.

## Hypotheses this data refuted

Recorded so they are not re-proposed:

- **"Preview vs production explains the inline STSO differences."** It does not.
  Production spans 388-440 s and preview 367-419 s — overlapping ranges, with
  the single slowest run of all twelve being a production run.
- **"The TTFS fast mode is a production-only effect."** No — a preview run hit it
  11/30, more often than any production run, and #3238 hit it 17/30.
- **"WO is an independent whole-run signal."** No. `WO − Σ(all STSO gaps)` is
  ~1.0-1.4 s; WO is the gap total plus step-body time, carrying nothing the STSO
  rows do not already.
- **"±8% is the inline detection floor."** That was measured on the first four
  runs available and understated it. With six runtime-identical preview runs the
  observed range is 13.2%, and production is the same. Use ±10% as a floor and
  expect occasional 13% excursions.

## Open items

1. **Tag queue-hops by invocation, not process** (finding 3). Requires exposing
   an invocation-scoped id to step bodies — `requestIdStorage` in
   `packages/world-vercel/src/queue.ts` already tracks one per request; nothing
   surfaces it to user code. Highest value: without it, the inline population is
   silently contaminated and the queue-hop count is wrong on an unpredictable
   subset of runs.
2. **Keep `raw` in run order.** `computeStats` stores `raw: sorted`, which
   destroys ordering at write time, so "is the slow tail concentrated in the last
   200 steps?" — the obvious event-log-growth hypothesis — cannot be tested from
   artifacts. Fix: store insertion order, sort locally inside `computeStats` for
   the percentiles. No output changes. Would also let a mislabeled hop be
   identified by position rather than by a >1.5 s heuristic.
3. **Baseline against a preview deployment of `main`, not production.** Removes
   the built-in TTFS bias (finding 5). Requires `main`'s benchmark job to deploy
   and target its own preview rather than switching on `github.ref`.
4. **Loosen or replace the p99 threshold for inline STSO.** At a 13% null range,
   a ±15% 🔻 will keep crying wolf.
5. **Report TTFS fast-mode fraction instead of (or beside) Best.**
6. **Consider repeated runs per commit.** With sd ≈ 5%, three runs would put the
   standard error near 3% and make sub-10% regressions detectable. Cost is ~7
   min/run of CI.
7. **Fix commit provenance on PR runs.** `.github/workflows/benchmarks.yml` sets
   `GITHUB_SHA` to the PR head sha for the benchmark step, and the job log
   confirms the step env holds it (`342f5a3a5…`) — but the written artifact
   records the synthetic `refs/pull/N/merge` sha (`9dfa2b64…`). Root cause not
   identified. Harmless for numbers, wrong for traceability.

## Reproducing this analysis

Download the artifacts for any set of runs (must be run from inside a clone):

```bash
gh run download <RUN_ID> --pattern 'bench-results-*' --dir /tmp/bench/<label>
```

Each `bench-results-*.json` carries the full sample arrays (`metrics[].raw`), so
no Datadog access is needed for distribution work. Useful run lists:

```bash
# production baselines
gh run list --workflow benchmarks.yml --branch main --limit 10 \
  --json databaseId,conclusion,createdAt,headSha
# every recent run, to find runtime-identical PRs (docs-only, lint-only, no-op)
gh run list --workflow benchmarks.yml --limit 30 \
  --json databaseId,conclusion,createdAt,headBranch,headSha
```

Only runs after `8bda7ce` (2026-07-30 20:38 UTC) have the inline/queue-hop
scenarios and `raw` arrays; earlier ones use the old step-index windows and
cannot be compared against these.

```js
// node -e '<this>'
const fs = require('node:fs'), path = require('node:path');
const load = (d) => {
  const out = [];
  (function walk(x) {
    for (const e of fs.readdirSync(x, { withFileTypes: true })) {
      const f = path.join(x, e.name);
      if (e.isDirectory()) walk(f);
      else if (/bench-results-.*\.json$/.test(e.name))
        out.push(JSON.parse(fs.readFileSync(f, 'utf8')));
    }
  })(d);
  return out;
};
const row = (r, m, s) => r.metrics.find((x) => x.metric === m && x.scenario === s);
const q = (a, p) => a[Math.min(a.length - 1, Math.ceil(p * a.length) - 1)];
const sum = (a) => a.reduce((x, y) => x + y, 0);
const mean = (a) => sum(a) / a.length;

for (const [name, dir] of [['A', '/tmp/bench/a'], ['B', '/tmp/bench/b']]) {
  const r = load(dir)[0];
  const a = row(r, 'stso', '1020 steps (inline)').raw;
  const hops = row(r, 'stso', '1020 steps (queue-hop)')?.raw ?? [];
  console.log(
    name,
    'cum', (sum(a) / 1000).toFixed(1) + 's',
    'mean', mean(a).toFixed(0),
    'p50', q(a, 0.5),
    'p99', q(a, 0.99),
    'reported hops', hops.length,
    // finding 3: hops onto a reused warm process land here instead
    'suspected mislabeled hops', a.filter((v) => v > 1500).length
  );
}
```

Note that `raw` is stored **sorted**, so quantile and histogram comparisons work
but anything order-dependent does not (open item 2).

## Background: what the metrics mean

`STSO` is split by whether the step ending a gap ran **inline** (same warm
process as the step before it — pure framework overhead) or after a
**queue-hop** (first step of a fresh process, paying queue dispatch, client
reinit and event-log replay). The workflow tags each step itself via a
process-global in `workbench/example/workflows/97_bench.ts` — ground truth
rather than inferred from step index or trace timestamps, but subject to the
blind spot in finding 3.

That split was introduced in [#3213](https://github.com/vercel/workflow/pull/3213)
because the previous step-index windows (`1-20` / `101-120` / `1001-1020`, 19
samples each) mixed the two populations: whether an invocation boundary happened
to land inside a window moved that window's P99 by hundreds of percent between
identical runs. The analysis above is what became visible once that noise source
was removed.

See `packages/core/e2e/benchmark.test.ts` for the full metric definitions.
