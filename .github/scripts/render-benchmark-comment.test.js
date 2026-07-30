const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const SCRIPT = path.join(__dirname, 'render-benchmark-comment.mjs');

// The script is ESM; load it lazily from the CJS test file.
const loadModule = () => import('./render-benchmark-comment.mjs');

function sampleResult(overrides = {}) {
  return {
    version: 1,
    methodologyVersion: 2,
    app: 'nextjs-turbopack',
    backend: 'vercel',
    generatedAt: '2026-07-08T12:00:00.000Z',
    commit: 'abcdef1234567890',
    config: {
      streamIterations: 30,
      sequentialIterations: 1,
      sequentialStepCount: 1020,
      warmupIterations: 2,
    },
    scenarios: [
      { name: 'stream', description: 'one streaming step in turbo mode' },
      { name: '1020 steps', description: 'trivial sequential steps' },
    ],
    metrics: [
      {
        metric: 'ttfs',
        scenario: 'stream',
        unit: 'ms',
        best: 320,
        avg: 412.3,
        p75: 398,
        p90: 512,
        p99: 634,
        samples: 30,
        targets: { p75: 200, p90: 300, p99: 600 },
      },
      {
        metric: 'sl',
        scenario: 'stream',
        unit: 'ms',
        best: 30,
        avg: 55.1,
        p75: 48,
        p90: 55,
        p99: 120,
        samples: 30,
        targets: { p75: 50, p90: 60, p99: 125 },
      },
      {
        metric: 'stso',
        scenario: '1020 steps (101-120)',
        unit: 'ms',
        best: 60,
        avg: 91,
        p75: 85,
        p90: 120,
        p99: 200,
        samples: 19,
        targets: { p75: 30, p90: 45, p99: 90 },
      },
      {
        metric: 'wo',
        scenario: 'stream',
        unit: 'ms',
        best: 900,
        avg: 1200,
        p75: 1100,
        p90: 1500,
        p99: 1900,
        samples: 30,
      },
    ],
    ...overrides,
  };
}

test('renders a completed run with a table and embedded history', async () => {
  const { renderComment, extractHistory } = await loadModule();
  const body = renderComment({
    status: 'completed',
    results: [sampleResult()],
    history: [],
    commit: 'abcdef1234567890',
    runUrl: 'https://github.com/vercel/workflow/actions/runs/1',
  });

  assert.match(body, /<!-- benchmark-results -->/);
  assert.match(body, /## 📊 Workflow Benchmarks/);
  assert.match(body, /\*\*TTFS\*\*/);
  assert.match(body, /\*\*SL\*\*/);
  assert.match(body, /\| stream \|/);
  assert.match(body, /1020 steps \(101-120\)/);
  // "ms" lives in the column headers, not in the cells; no Avg column
  assert.match(
    body,
    /\| Best \(ms\) \| P75 \(ms\) \| P90 \(ms\) \| P99 \(ms\) \|/
  );
  assert.doesNotMatch(body, /Avg \(ms\)/);
  assert.doesNotMatch(body, /\d ms \|/);
  // Best cell (fastest sample) renders before P75 (warm-start floor for TTFS)
  assert.match(body, /\| 320 \| 398 🔴 \|/);
  // Metric definitions live in the footer, not in the table rows
  assert.doesNotMatch(body, /\| \*\*TTFS\*\* <sub>/);
  // The smallprint footer is collapsed into a dropdown, like "Previous results"
  assert.match(
    body,
    /<details>\n<summary>ℹ️ Metric definitions & methodology<\/summary>/
  );
  assert.match(body, /<sub>Metrics — \*\*TTFS\*\*: time to first step body/);
  assert.match(body, /\*\*SL\*\*: stream latency/);
  // Scenario legend from the runner-provided descriptions
  assert.match(
    body,
    /<sub>Scenarios — \*\*stream\*\*: one streaming step in turbo mode/
  );
  // Target marks: TTFS p75 398 > 200 → 🔴; SL row is within target on every
  // percentile, so it stays unmarked (no 🟢 anywhere); WO has no targets.
  assert.match(body, /398 🔴/);
  assert.match(body, /\| 30 \| 48 \| 55 \| 120 \|/);
  assert.doesNotMatch(body, /🟢/);
  assert.match(body, /\| 1100 \|/);
  // Targets legend derived from row targets
  assert.match(body, /Targets \(p75\/p90\/p99, ms\) — TTFS 200\/300\/600/);
  assert.match(body, /STSO \(101-120\) 30\/45\/90/);
  assert.match(body, /SL 50\/60\/125/);
  assert.match(body, /commit `abcdef1`/);
  // No previous results yet
  assert.doesNotMatch(body, /Previous results/);
  // History round-trips through the embedded data block
  const history = extractHistory(body);
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].commit, 'abcdef1234567890');
  assert.strictEqual(history[0].results[0].metrics.length, 4);
});

test('renders both SO payload-shape rows under one metric', async () => {
  const { renderComment } = await loadModule();
  const soRow = (scenario, overrides) => ({
    metric: 'so',
    scenario,
    unit: 'ms',
    best: 40,
    avg: 120,
    p75: 110,
    p90: 220,
    p99: 380,
    samples: 30,
    targets: { p75: 250, p90: 500, p99: 1000 },
    ...overrides,
  });
  const result = sampleResult({
    scenarios: [
      {
        name: 'stream overhead (text)',
        description: 'raw string token deltas',
      },
      {
        name: 'stream overhead (structured)',
        description: 'AI-SDK-style structured deltas',
      },
    ],
    metrics: [
      soRow('stream overhead (text)'),
      soRow('stream overhead (structured)', { p75: 140, p90: 260, p99: 440 }),
    ],
  });
  const body = renderComment({
    status: 'completed',
    results: [result],
    history: [],
    commit: 'abcdef1234567890',
  });

  // Both payload shapes render as distinct SO rows.
  assert.match(body, /\| \*\*SO\*\* \| stream overhead \(text\) \|/);
  assert.match(body, /\| \*\*SO\*\* \| stream overhead \(structured\) \|/);
  // Both scenarios are described in the (collapsed) footer legend.
  assert.match(
    body,
    /\*\*stream overhead \(text\)\*\*: raw string token deltas/
  );
  assert.match(
    body,
    /\*\*stream overhead \(structured\)\*\*: AI-SDK-style structured deltas/
  );
  // Within target on every percentile → neither SO row carries a 🔴 mark.
  assert.doesNotMatch(body, /\| \*\*SO\*\* \|.*🔴/);
  // Both rows share the one SO metric definition and targets entry.
  assert.match(body, /\*\*SO\*\*: stream overhead/);
  assert.match(body, /Targets \(p75\/p90\/p99, ms\) — SO 250\/500\/1000/);
});

test('renders best/p75/p90/p99 deltas with 🔻/💚 threshold marks and embeds them', async () => {
  const { renderComment, extractHistory } = await loadModule();
  const baseline = sampleResult({
    metrics: sampleResult()
      .metrics.filter((row) => row.metric !== 'wo') // no baseline for WO
      .map((row) => ({
        ...row,
        // ttfs: best 320 vs 250 → +28% 🔻, p75 398 vs 500 → -20% 💚,
        //       p90 512 vs 512 → ±0%, p99 634 vs 600 → +5.7% (no mark).
        // sl/stso baselines equal the run → ±0% everywhere.
        best: { ttfs: 250, sl: 30, stso: 60 }[row.metric],
        p75: { ttfs: 500, sl: 48, stso: 85 }[row.metric],
        p90: { ttfs: 512, sl: 55, stso: 120 }[row.metric],
        p99: { ttfs: 600, sl: 120, stso: 200 }[row.metric],
      })),
  });
  const body = renderComment({
    status: 'completed',
    results: [sampleResult()],
    baseline: [baseline],
    history: [],
    commit: 'abcdef1234567890',
  });

  // Best regression past +15% → 🔻
  assert.match(body, /\| 320 \(\+28%\) 🔻 \|/);
  // P75 improvement past -15% → 💚 (alongside the 🔴 target miss)
  assert.match(body, /398 🔴 \(-20%\) 💚/);
  // P90 now carries a delta (previously undecorated); ±0%, no threshold mark
  assert.match(body, /512 🔴 \(±0%\) \|/);
  // P99 small delta, no threshold mark
  assert.match(body, /634 🔴 \(\+5\.7%\) \|/);
  // WO has no baseline row → no delta on its Best cell
  assert.match(body, /\| 900 \|/);
  assert.match(
    body,
    /Best\/P75\/P90\/P99 deltas compare against the most recent benchmark run on `main`/
  );
  assert.match(body, /💚 one better than/);
  // The annotations are embedded so history re-renders keep the deltas
  const history = extractHistory(body);
  assert.strictEqual(history[0].results[0].metrics[0].baselineBest, 250);
  assert.strictEqual(history[0].results[0].metrics[0].baselineP90, 512);
  const rerendered = renderComment({
    status: 'running',
    results: [],
    history,
    commit: 'ffffff1234567890',
  });
  assert.match(rerendered, /\| 320 \(\+28%\) 🔻 \|/);
});

test('suppresses deltas when the baseline methodology version differs', async () => {
  const { renderComment } = await loadModule();
  // Old-methodology baseline (e.g. proxy-inclusive TTFS) must not be diffed
  // against a new-methodology run, even though backend/app/metric/scenario
  // match — the numbers are not comparable.
  const baseline = sampleResult({
    methodologyVersion: 1,
    metrics: sampleResult().metrics.map((row) => ({ ...row, best: 200 })),
  });
  const body = renderComment({
    status: 'completed',
    results: [sampleResult()], // methodologyVersion: 2
    baseline: [baseline],
    history: [],
    commit: 'abcdef1234567890',
  });
  // No percentage deltas, and the "compare against main" note is absent.
  assert.doesNotMatch(body, /%\)/);
  assert.doesNotMatch(body, /deltas compare against/);
});

test('renders no deltas without a baseline', async () => {
  const { renderComment } = await loadModule();
  const body = renderComment({
    status: 'completed',
    results: [sampleResult()],
    history: [],
    commit: 'abcdef1234567890',
  });
  assert.doesNotMatch(body, /%\)/);
  assert.doesNotMatch(body, /deltas compare against/);
});

test('collapses previous results on re-runs', async () => {
  const { renderComment, extractHistory } = await loadModule();
  const first = renderComment({
    status: 'completed',
    results: [sampleResult()],
    history: [],
    commit: '1111111aaaaaaa',
    runUrl: 'https://example.com/run/1',
  });
  const second = renderComment({
    status: 'completed',
    results: [sampleResult()],
    history: extractHistory(first),
    commit: '2222222bbbbbbb',
    runUrl: 'https://example.com/run/2',
  });

  // Latest commit shown prominently, previous one collapsed
  assert.match(second, /commit `2222222`/);
  assert.match(
    second,
    /<details>\n<summary>📜 Previous results \(1\)<\/summary>/
  );
  assert.match(second, /#### 1111111/);
  const history = extractHistory(second);
  assert.strictEqual(history.length, 2);
  assert.strictEqual(history[0].commit, '2222222bbbbbbb');
});

test('running status preserves previous results and history', async () => {
  const { renderComment, extractHistory } = await loadModule();
  const first = renderComment({
    status: 'completed',
    results: [sampleResult()],
    history: [],
    commit: '1111111aaaaaaa',
  });
  const running = renderComment({
    status: 'running',
    results: [],
    history: extractHistory(first),
    commit: '2222222bbbbbbb',
  });

  assert.match(running, /Benchmarks are running for `2222222`/);
  assert.match(running, /Results below are from a previous run/);
  // Previous results still rendered and history unchanged
  assert.match(running, /398 🔴/);
  const history = extractHistory(running);
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].commit, '1111111aaaaaaa');
});

test('failed status renders a failure banner', async () => {
  const { renderComment } = await loadModule();
  const body = renderComment({
    status: 'failed',
    results: [],
    history: [],
    commit: '3333333ccccccc',
    runUrl: 'https://example.com/run/3',
  });
  assert.match(body, /❌ \*\*The benchmark run for `3333333` failed\.\*\*/);
  assert.match(body, /No benchmark results were produced/);
});

test('caps history at 10 entries', async () => {
  const { renderComment, extractHistory } = await loadModule();
  let history = [];
  for (let i = 0; i < 12; i++) {
    const body = renderComment({
      status: 'completed',
      results: [sampleResult()],
      history,
      commit: `${i}`.repeat(10),
    });
    history = extractHistory(body);
  }
  assert.strictEqual(history.length, 10);
  assert.strictEqual(history[0].commit, '11'.repeat(10));
});

test('ignores malformed data blocks', async () => {
  const { extractHistory } = await loadModule();
  assert.deepStrictEqual(extractHistory(undefined), []);
  assert.deepStrictEqual(extractHistory('no marker here'), []);
  assert.deepStrictEqual(
    extractHistory('<!-- benchmark-data:!!!not-base64!!! -->'),
    []
  );
  const garbage = Buffer.from('not json', 'utf8').toString('base64');
  assert.deepStrictEqual(
    extractHistory(`<!-- benchmark-data:${garbage} -->`),
    []
  );
});

test('CLI renders results from a directory and previous body file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-render-'));
  const resultsDir = path.join(dir, 'results');
  fs.mkdirSync(resultsDir);
  fs.writeFileSync(
    path.join(resultsDir, 'bench-results-nextjs-turbopack-vercel.json'),
    JSON.stringify(sampleResult())
  );

  const firstOut = path.join(dir, 'comment1.md');
  execFileSync(process.execPath, [
    SCRIPT,
    '--status',
    'completed',
    '--results-dir',
    resultsDir,
    '--commit',
    '1111111aaaaaaa',
    '--run-url',
    'https://example.com/run/1',
    '--output',
    firstOut,
  ]);
  const first = fs.readFileSync(firstOut, 'utf8');
  assert.match(first, /398 🔴/);

  // Baseline files arrive nested in per-artifact subdirectories (that's how
  // the download action extracts them); loadResults must find them anyway.
  const baselineDir = path.join(dir, 'baseline');
  fs.mkdirSync(
    path.join(baselineDir, 'bench-results-nextjs-turbopack-vercel'),
    {
      recursive: true,
    }
  );
  const baseline = sampleResult();
  baseline.metrics = baseline.metrics.map((row) => ({ ...row, best: 300 }));
  fs.writeFileSync(
    path.join(
      baselineDir,
      'bench-results-nextjs-turbopack-vercel',
      'bench-results-nextjs-turbopack-vercel.json'
    ),
    JSON.stringify(baseline)
  );

  const secondOut = path.join(dir, 'comment2.md');
  execFileSync(process.execPath, [
    SCRIPT,
    '--status',
    'completed',
    '--results-dir',
    resultsDir,
    '--baseline-dir',
    baselineDir,
    '--previous-body',
    firstOut,
    '--commit',
    '2222222bbbbbbb',
    '--output',
    secondOut,
  ]);
  const second = fs.readFileSync(secondOut, 'utf8');
  assert.match(second, /Previous results \(1\)/);
  assert.match(second, /#### 1111111/);
  // ttfs best 320 vs baseline 300 → +6.7%
  assert.match(second, /\| 320 \(\+6\.7%\) \|/);
});

test('CLI fails when completed with no results', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-render-empty-'));
  assert.throws(() =>
    execFileSync(
      process.execPath,
      [SCRIPT, '--status', 'completed', '--results-dir', dir],
      { stdio: 'pipe' }
    )
  );
});

/** A sequential-steps result whose STSO rows carry raw samples, as the
 * benchmark runner now records them (every gap, not a sampled window). */
function sequentialResult({ inline, queueHop }) {
  const stsoRow = (scenario, raw) => ({
    metric: 'stso',
    scenario,
    unit: 'ms',
    best: Math.min(...raw),
    avg: raw.reduce((a, b) => a + b, 0) / raw.length,
    p75: raw[Math.ceil(0.75 * raw.length) - 1],
    p90: raw[Math.ceil(0.9 * raw.length) - 1],
    p99: raw[Math.ceil(0.99 * raw.length) - 1],
    samples: raw.length,
    raw,
  });
  return sampleResult({
    scenarios: [
      { name: '1020 steps', description: 'trivial sequential steps' },
    ],
    metrics: [
      stsoRow('1020 steps (inline)', inline),
      stsoRow('1020 steps (queue-hop)', queueHop),
    ],
  });
}

test('renders inline and queue-hop STSO histogram diffs against main', async () => {
  const { renderComment } = await loadModule();
  const body = renderComment({
    status: 'completed',
    // Two inline steps move from the 350-400ms bucket down to 150-200ms.
    results: [
      sequentialResult({
        inline: [160, 190, 360, 360],
        queueHop: [2100, 2600],
      }),
    ],
    baseline: [
      sequentialResult({
        inline: [360, 360, 360, 360],
        queueHop: [2100, 2100],
      }),
    ],
    history: [],
    commit: 'abcdef1234567890',
  });

  assert.match(body, /\*\*STSO distribution vs `main`\*\*/);
  assert.match(body, /_1020 steps \(inline\)_/);
  assert.match(body, /_1020 steps \(queue-hop\)_/);
  // Cumulative time diff: inline 1440ms → 1070ms.
  assert.match(
    body,
    /Cumulative STSO time: main 1440ms → this run 1070ms \(Δ -370ms, -26%\)/
  );
  // Inline rows are bucketed at a hardcoded 50ms, so the two fast samples
  // land in 150-200 and the bucket the baseline occupied loses them. Counts
  // and the per-bucket delta ride on the bar line; there is no second table.
  assert.match(body, /^ *150-200 ms .*main 0 +this 2 +\+2$/m);
  assert.match(body, /^ *350-400 ms .*main 4 +this 2 +-2$/m);
  assert.doesNotMatch(body, /Bucket \(ms\)/);
  // Queue-hop rows keep the adaptive (much coarser) bin width.
  assert.doesNotMatch(body, /2100-2150 ms/);
  assert.match(body, /^ *2000-2500 ms .*main 2 +this 1 +-1$/m);
  assert.match(body, /^ *2500-3000 ms .*main 0 +this 1 +\+1$/m);
  // Overlay bars: solid run for main, notch for this run.
  assert.match(body, /█+┃/);
  assert.match(
    body,
    /<sub>The \*\*STSO distribution\*\* section buckets every/
  );
});

test('shows the STSO distribution alone when main has no raw samples', async () => {
  const { renderComment } = await loadModule();
  const run = sequentialResult({ inline: [160, 360], queueHop: [2100] });
  // A pre-raw-samples baseline: same rows, percentiles only.
  const baseline = sequentialResult({ inline: [160, 360], queueHop: [2100] });
  for (const row of baseline.metrics) delete row.raw;

  const body = renderComment({
    status: 'completed',
    results: [run],
    baseline: [baseline],
    history: [],
    commit: 'abcdef1234567890',
  });

  assert.match(body, /\*\*STSO distribution\*\*/);
  assert.doesNotMatch(body, /STSO distribution vs `main`/);
  assert.match(body, /No `main` baseline with raw samples yet/);
  assert.match(body, /Cumulative STSO time: 520ms over 2 samples/);
  // Single-series rendering: one count per bucket, no main/this or delta.
  assert.match(body, /^ *150-200 ms .*steps 1$/m);
  assert.doesNotMatch(body, /this \d/);
  assert.doesNotMatch(body, /Bucket \(ms\)/);
});

test('strips raw samples from the embedded history data block', async () => {
  const { renderComment, extractHistory } = await loadModule();
  const inline = Array.from({ length: 1000 }, (_, i) => 200 + (i % 300));
  const body = renderComment({
    status: 'completed',
    results: [sequentialResult({ inline, queueHop: [2100, 2600] })],
    baseline: [sequentialResult({ inline, queueHop: [2100, 2600] })],
    history: [],
    commit: 'abcdef1234567890',
  });

  // The histogram renders for the current run...
  assert.match(body, /\*\*STSO distribution vs `main`\*\*/);
  // ...but the ~1000 samples behind it never reach the embedded data block,
  // which would otherwise blow past GitHub's comment size limit as history
  // accumulates.
  const history = extractHistory(body);
  const row = history[0].results[0].metrics[0];
  assert.strictEqual(row.raw, undefined);
  assert.strictEqual(row.baselineRaw, undefined);
  assert.strictEqual(row.samples, 1000);
  assert.ok(body.length < 20_000, `comment is ${body.length} chars`);

  // Re-rendering from that history keeps the table but drops the histogram.
  const rerendered = renderComment({
    status: 'running',
    results: [],
    history,
    commit: 'ffffff1234567890',
  });
  assert.match(rerendered, /1020 steps \(inline\)/);
  assert.doesNotMatch(rerendered, /STSO distribution/);
});

test('buckets negative STSO gaps separately from the slow tail', async () => {
  const { renderComment } = await loadModule();
  // Consecutive step timestamps come from different step bodies, so a gap can
  // come out slightly negative under clock skew — it must not be counted with
  // the slowest samples.
  const body = renderComment({
    status: 'completed',
    results: [sequentialResult({ inline: [-40, 160, 360], queueHop: [2100] })],
    baseline: [sequentialResult({ inline: [160, 360], queueHop: [2100] })],
    history: [],
    commit: 'abcdef1234567890',
  });

  assert.match(body, /^ *<0 \(skew\) ms .*main 0 +this 1 +\+1$/m);
  // ...and the top bucket still reflects only genuinely slow samples.
  assert.match(body, /^ *350-400 ms .*main 1 +this 1 +\+0$/m);
});
