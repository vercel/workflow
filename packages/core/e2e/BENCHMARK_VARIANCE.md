# Benchmark variance analysis

_Analysis date: 2026-07-30. Data: five CI benchmark runs of `nextjs-turbopack` on
the `vercel` backend, methodology version 2._

This documents where run-to-run variance in the Performance Benchmarks job
actually comes from, measured against real CI data rather than inferred. It
exists because the benchmark comment was reporting large deltas — up to +523%
— on changes that could not possibly have caused them, which made the whole
report easy to dismiss.

The headline: **the measurement is precise, but each run measures a different
deployment, and deployments differ from each other by more than most real
regressions would.** Two runs of identical code agreed to within 0.2%; a third
was 8% slower across its entire distribution.

## Detection floor (the practical takeaway)

Measured as the spread across four preview runs of **identical runtime code**.
A delta smaller than this is not evidence of anything.

| Signal | Null spread | Verdict |
|---|---|---|
| inline STSO — cumulative / mean | ±8% | usable above ~8% |
| inline STSO — p50 | 365-409 ms (±6%) | usable, similar |
| inline STSO — p99 | 731-790 ms (±8%) | the ±15% 🔻 threshold is only ~2× the noise |
| inline STSO — tail count (>700 ms) | 12-23 samples | very noisy, do not gate on it |
| queue-hop STSO — count | exactly 3, every run | stable |
| queue-hop STSO — per-hop cost | 1545-3446 ms (n=3/run) | too few samples to read |
| TTFS — p50 | ±3% within an environment | usable, but see the preview/production bias below |
| TTFS — Best | 0-11 fast samples out of 30 | not a usable signal |

## Dataset

All five runs execute the same workload: `benchSequentialStepsWorkflow(1020)`,
one iteration, yielding 1016 inline STSO samples and 3 queue-hop samples each.

| Run | When (UTC) | Env | CI run | Head SHA |
|---|---|---|---|---|
| PR #3213 | 18:30 | preview | [30570697187](https://github.com/vercel/workflow/actions/runs/30570697187) | `95cf46a` |
| PR #3213 | 18:58 | preview | [30572791924](https://github.com/vercel/workflow/actions/runs/30572791924) | `1bfc037` |
| PR #3213 | 19:34 | preview | [30575442330](https://github.com/vercel/workflow/actions/runs/30575442330) | `342f5a3` |
| `main` (post-merge) | 21:04 | **production** | [30580048090](https://github.com/vercel/workflow/actions/runs/30580048090) | `8bda7ce` |
| PR #3101 (no-op) | 21:30 | preview | [30582183243](https://github.com/vercel/workflow/actions/runs/30582183243) | `32225d9` |

The three PR #3213 runs are the important control: their later commits touched
only `.github/scripts/render-benchmark-comment.mjs` and its tests, so **the
runtime code and the benchmark workload were byte-identical across all three**.
PR #3101 adds a single `// NO-OP` comment line to `packages/core/src/runtime.ts`
and is likewise runtime-identical.

## The data

### Inline STSO (n = 1016 per run)

```
run                    cum(s)   mean   p10   p50   p90   p99    max  tail>700  body<=700
#3213 @18:30 (prev)     386.0    380   238   378   515   743   1232      12       374
#3213 @18:58 (prev)     386.8    381   235   376   517   731   1179      15       374
#3213 @19:34 (prev)     416.7    410   257   409   554   736   1068      16       404
#3101 @21:30 (prev)     392.4    386   241   365   531   790   1328      23       375
main  @21:04 (PROD)     408.2    402   253   406   535   684   1044       8       398
```

`tail>700` is the count of samples above 700 ms; `body<=700` is the mean of
everything at or below it.

### TTFS (step scenario, n = 30) and queue-hops

```
run                  fast<600ms    min    p50   | hops  values (ms)
#3213 @18:30 (prev)        0/30   1267   1300   |    3  [2270, 3013, 3446]
#3213 @18:58 (prev)        0/30   1275   1304   |    3  [2256, 3107, 3125]
#3213 @19:34 (prev)       11/30    273   1308   |    3  [1545, 2125, 2632]
#3101 @21:30 (prev)        0/30   1308   1340   |    3  [2160, 3108, 3168]
main  @21:04 (PROD)        6/30    210   1039   |    3  [1628, 2384, 2995]
```

`fast<600ms` counts samples in the fast TTFS mode (see finding 3).

## Findings

### 1. The measurement is precise; the deployments are not

The 18:30 and 18:58 runs — separate preview deployments, separate 1020-step
executions — agree to **0.2%** on cumulative inline time (386.0 s vs 386.8 s)
and **0.3%** on body mean (374 vs 374). A 1016-sample run is a stable
instrument.

So the between-run differences are not sampling noise. They are real
differences between the deployments being measured.

### 2. One deployment was simply slower, across its whole distribution

The 19:34 run sits to the right at every quantile: p10 257 vs ~236, p50 409 vs
~377, body mean 404 vs ~374. That is +8%, and it is not a tail artifact — the
entire body moved.

This is the single largest source of inline variance, and nothing about the
workload explains it. Some deployments land slow and stay slow for the whole
run. Suspects (unconfirmed): instance placement, neighbour load on shared
infrastructure, pool warmth at allocation time.

### 3. Body and tail are separate signals that move independently

For PR #3101 vs the `main` baseline, the comment flagged `P99 +15% 🔻` — but:

- body (≤700 ms, ~98% of samples): mean 375 vs 398, i.e. **6% faster**
- tail (>700 ms): 23 samples vs 8, total 19.7 s vs 6.7 s
- cumulative: −4%, which is a −29 s body improvement plus a +13 s tail regression

**The 🔻 was driven by 15 samples out of 1016.** Across the preview cohort the
tail count ranges 12-23 and prod's 8 was the cohort minimum, so the flag was
"fattest preview tail vs thinnest production tail," not a change in step cost.

Whether the tail is concentrated late in the run (growing event log) or
scattered is **currently untestable** — see open item 2.

### 4. TTFS is bimodal, and mode occupancy is a lottery

TTFS samples fall into a fast mode (~200-400 ms, the in-process fast path) and a
slow mode (~1300 ms). How many of a run's 30 samples land in the fast mode is
close to random: 0, 0, **11**, 0 across previews and 6 on production.

Because **Best is a min over 30 samples**, a single lucky sample moves it 5×.
That is the mechanism behind the `+523% 🔻` on a no-op change. Best is not a
usable regression signal in its current form; the fast-mode *fraction* would be.

### 5. Preview vs production is a real bias — but only for TTFS median

```
TTFS(step) p50:  preview 1300, 1304, 1308, 1340   |   production 1039
```

The four preview medians agree within 3%; production is **20% faster than all
of them**. Since `main` runs against production
(`environment: ${{ github.ref == 'refs/heads/main' && 'production' || 'preview' }}`,
`.github/workflows/benchmarks.yml`) and every PR runs against preview, **every
PR carries a built-in ~+25% TTFS "regression" that is pure environment
mismatch**.

### 6. The queue-hop count is stable

Every run crossed exactly 3 invocation boundaries — the ~120 s per-invocation
ceiling and the total run duration are consistent. Only the per-hop cost varies
(1545-3446 ms), and with n=3 per run those percentiles are degenerate: p75, p90
and p99 all collapse to the max sample.

## Hypotheses this data refuted

Recorded so they are not re-proposed:

- **"Preview vs production explains the inline STSO differences."** It does not.
  Production (408.2 s) sits *inside* the preview range (386-417 s); one preview
  run was slower than production. The environment split is a real bias for TTFS
  p50 only.
- **"The TTFS fast mode is a production-only effect."** No — the 19:34 preview
  run hit it 11 times out of 30, more often than production did.
- **"WO is an independent whole-run signal."** It is not. `WO − Σ(all STSO gaps)`
  is 1019 ms (main) and 1362 ms (this) — WO is the gap total plus step-body
  time, so it carries nothing the STSO rows do not already.

## Open items

1. **Baseline against a preview deployment of `main`, not production.** Removes
   the built-in TTFS bias (finding 5). Requires `main`'s benchmark job to deploy
   and target its own preview rather than switching on `github.ref`.
2. **Keep `raw` in run order.** `computeStats` currently stores `raw: sorted`,
   which destroys ordering at write time, so "is the slow tail concentrated in
   the last 200 steps?" — the obvious event-log-growth hypothesis — cannot be
   tested from artifacts. Fix: store insertion order, sort locally inside
   `computeStats` for the percentiles. No output changes.
3. **Loosen or replace the p99 threshold for inline STSO.** At ±8% null spread,
   a ±15% 🔻 will keep crying wolf. Body mean or p50 is the tighter signal.
4. **Report TTFS fast-mode fraction instead of (or beside) Best.** Best is a min
   over 30 samples and therefore a lottery; the fraction is the real signal.
5. **Fix commit provenance on PR runs.** `.github/workflows/benchmarks.yml` sets
   `GITHUB_SHA` to the PR head sha for the benchmark step, and the job log
   confirms the step env holds it (`342f5a3a5…`) — but the written artifact
   records the synthetic `refs/pull/N/merge` sha (`9dfa2b64…`) instead. Root
   cause not yet identified. Harmless for numbers, wrong for traceability.

## Reproducing this analysis

Download the artifacts for any two runs (must be run from inside a clone):

```bash
gh run download <RUN_ID> --pattern 'bench-results-*' --dir /tmp/bench/<label>
```

Each `bench-results-*.json` carries the full sample arrays (`metrics[].raw`), so
no Datadog access is needed for distribution work. Compare them with:

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
  const a = row(load(dir)[0], 'stso', '1020 steps (inline)').raw;
  console.log(
    name,
    'cum', (sum(a) / 1000).toFixed(1) + 's',
    'mean', mean(a).toFixed(0),
    'p50', q(a, 0.5),
    'p99', q(a, 0.99),
    'tail>700', a.filter((v) => v > 700).length,
    'body<=700', mean(a.filter((v) => v <= 700)).toFixed(0)
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
process-global in `workbench/example/workflows/97_bench.ts`; the split is ground
truth, not inferred from step index or trace timestamps.

That split was introduced in [#3213](https://github.com/vercel/workflow/pull/3213)
precisely because the previous step-index windows (`1-20` / `101-120` /
`1001-1020`, 19 samples each) mixed the two populations: whether an invocation
boundary happened to land inside a window moved that window's P99 by hundreds of
percent between identical runs. The analysis above is what became visible once
that noise source was removed.

See `packages/core/e2e/benchmark.test.ts` for the full metric definitions.
