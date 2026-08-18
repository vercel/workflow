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
      replayCadences: [
        {
          id: 'eve-test-cadence',
          model: 'test-model',
          events: 823,
          spanMs: 6196,
          totalBytes: 2000000,
          semanticSha256:
            '609bc99fb5eb810086dcaecc9128f5fecd7c75d8bc3f2b39a6622f89d5a5a47a',
        },
      ],
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
  // Replay-cadence identity line: full semantic hash on its own legend line
  assert.match(
    body,
    /<sub>Replay cadences \(semantic sha256\) — \*\*eve-test-cadence\*\* `609bc99fb5eb810086dcaecc9128f5fecd7c75d8bc3f2b39a6622f89d5a5a47a`<\/sub>/
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

test('renders the fan-out scenario as one Fan-out TTFS row and one Fan-out TTLS row', async () => {
  const { renderComment } = await loadModule();
  const fanOutRow = (metric, overrides) => ({
    metric,
    scenario: 'Promise.all(100 steps)',
    unit: 'ms',
    best: 300,
    avg: 420,
    p75: 450,
    p90: 520,
    p99: 700,
    samples: 10,
    ...overrides,
  });
  const result = sampleResult({
    scenarios: [
      {
        name: 'Promise.all(100 steps)',
        description: '100 trivial no-op steps started together',
      },
    ],
    metrics: [
      // Deliberately out of display order: the table sorts by METRIC_ORDER.
      fanOutRow('fanout-ttls', { best: 900, p75: 1400, p90: 1800, p99: 2600 }),
      fanOutRow('fanout-ttfs'),
      sampleResult().metrics[0],
    ],
  });
  const body = renderComment({
    status: 'completed',
    results: [result],
    history: [],
    commit: 'abcdef1234567890',
  });

  assert.match(
    body,
    /\| \*\*Fan-out TTFS\*\* \| Promise\.all\(100 steps\) \| 300 \|/
  );
  assert.match(
    body,
    /\| \*\*Fan-out TTLS\*\* \| Promise\.all\(100 steps\) \| 900 \|/
  );
  // Neither row falls back to the raw metric id.
  assert.doesNotMatch(body, /\| fanout-ttfs \|/);
  assert.doesNotMatch(body, /\| fanout-ttls \|/);
  // Display order: single-step TTFS, then the fan-out pair with first before last.
  const order = ['**TTFS**', '**Fan-out TTFS**', '**Fan-out TTLS**'].map(
    (name) => body.indexOf(name)
  );
  assert.ok(
    order.every((index, i) => index > -1 && (i === 0 || index > order[i - 1])),
    `unexpected row order: ${JSON.stringify(order)}`
  );
  // Both metrics are defined in the collapsed footer.
  assert.match(body, /\*\*Fan-out TTFS\*\*: fan-out time to first step/);
  assert.match(body, /\*\*Fan-out TTLS\*\*: fan-out time to last step/);
  // No targets on the fan-out rows, so they contribute nothing to the targets
  // legend and carry no 🔴 marks.
  assert.doesNotMatch(body, /Targets \(p75\/p90\/p99, ms\) —[^<]*Fan-out/);
  assert.doesNotMatch(body, /\| \*\*Fan-out TT[FL]S\*\* \|[^\n]*🔴/);
});

test('diffs fan-out rows against a baseline keyed on their own metric ids', async () => {
  const { renderComment } = await loadModule();
  const fanOutRow = (metric, best) => ({
    metric,
    scenario: 'Promise.all(100 steps)',
    unit: 'ms',
    best,
    avg: best,
    p75: best,
    p90: best,
    p99: best,
    samples: 10,
  });
  const metricsFor = (ttfsBest, ttlsBest) => [
    fanOutRow('fanout-ttfs', ttfsBest),
    fanOutRow('fanout-ttls', ttlsBest),
  ];
  const body = renderComment({
    status: 'completed',
    // First branch lands as fast as on main; the tail is 50% slower.
    results: [sampleResult({ metrics: metricsFor(300, 1500) })],
    baseline: [sampleResult({ metrics: metricsFor(300, 1000) })],
    history: [],
    commit: 'abcdef1234567890',
  });

  // TTFS unchanged, TTLS regressed — the two rows carry independent deltas,
  // which is the point of splitting them.
  assert.match(body, /\| \*\*Fan-out TTFS\*\* \|[^\n]*300 \(±0%\)/);
  assert.match(body, /\| \*\*Fan-out TTLS\*\* \|[^\n]*1500 \(\+50%\) 🔻/);
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

// Fixed log-bin edges matching RTT_HIST_EDGES_MS in the bench helper module
// (workbench/example/workflows/97_bench_rtt.ts).
const CRTT_EDGES = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];

/** Histogram over CRTT_EDGES with counts placed by (value, count) pairs. */
function crttHist(entries) {
  const counts = new Array(CRTT_EDGES.length + 1).fill(0);
  for (const [value, count] of entries) {
    let bin = 0;
    while (bin < CRTT_EDGES.length && value >= CRTT_EDGES[bin]) bin++;
    counts[bin] += count;
  }
  return counts;
}

function crttResult({ avg = 120, hist }) {
  const streamRow = (scenario, group, extra = {}) => ({
    metric: 'stream',
    scenario,
    unit: 'ms',
    best: 59,
    avg,
    p50: 128,
    p75: 188,
    p90: 438,
    p99: 1229,
    samples: hist.reduce((a, b) => a + b, 0),
    raw: [],
    hist: { edgesMs: CRTT_EDGES, counts: hist },
    group,
    bucket: 'all',
    stream: {
      iterations: 10,
      wrCps: 100,
      wrKiBps: 6.1,
      rdCps: 99.4,
      rdKiBps: 6,
      firstMs: 96,
      cdvMaxMs: 141,
      runs: [
        { wrCps: 100, rdCps: 99.4, firstMs: 96, cdvMaxMs: 141, slipMaxMs: 4 },
      ],
    },
    ...extra,
  });
  return sampleResult({
    scenarios: [
      { name: 'chunk RTT (llm)', description: 'self-timestamping chunks' },
    ],
    metrics: [
      streamRow('chunk RTT (llm)', 'llm', {
        progressAvgMs: [110, 112, 115, 113, 118, 120, 119, 125, 130, 135],
        cdvAvgMs: [2, 2, 3, 5, 9, 15, 24, 40, 66, 108],
      }),
      // Artifact-only detail rows: per-index CRTT split and slip tail.
      {
        metric: 'crtt',
        scenario: 'chunk RTT llm (seq 0)',
        unit: 'ms',
        best: 97,
        avg: 130,
        p50: 112,
        p75: 126,
        p90: 129,
        p99: 157,
        samples: 10,
        raw: [],
        group: 'llm',
        bucket: 'seq 0',
        detail: true,
      },
      {
        metric: 'slip',
        scenario: 'write slip (llm)',
        unit: 'ms',
        best: 2,
        avg: 3,
        p50: 3,
        p75: 4,
        p90: 5,
        p99: 6,
        samples: 10,
        raw: [],
        group: 'llm',
        detail: true,
      },
      streamRow('replay eve-test (2x)', 'replay', {
        stream: {
          iterations: 5,
          wrCps: 297,
          wrKiBps: 742,
          rdCps: 288,
          rdKiBps: 719,
          firstMs: 118,
          cdvMaxMs: 210,
          runs: [
            {
              wrCps: 297,
              rdCps: 288,
              firstMs: 118,
              cdvMaxMs: 210,
              slipMaxMs: 9,
            },
          ],
        },
      }),
    ],
  });
}

test('renders stream scenarios in their own table with rate columns', async () => {
  const { renderComment, extractHistory } = await loadModule();
  const hist = crttHist([
    [59, 1400],
    [128, 1500],
    [438, 100],
  ]);
  const baseline = crttResult({ avg: 150, hist });
  // Baseline medians differ so deltas render: rd rate was lower on main.
  baseline.metrics[0].stream.rdCps = 90;
  const body = renderComment({
    status: 'completed',
    results: [crttResult({ avg: 120, hist })],
    baseline: [baseline],
    history: [],
    commit: 'abcdef1234567890',
  });

  // Stream rows are OUT of the metric table and IN the Streams table.
  assert.doesNotMatch(body, /\| \*\*stream\*\* \|/);
  assert.match(
    body,
    /\| Scenario \| wr c\/s \| rd c\/s \| wr KiB\/s \| rd KiB\/s \| CRTT 1st \| p75 \| p90 \| p99 \| CDV max \| iters \|/
  );
  // Rate cells with plain vs-main deltas, latency cells from percentile
  // baselines, and NO red/green marks anywhere in the stream table.
  assert.match(
    body,
    /\| chunk RTT \(llm\) \| 100 \(\u00b10%\) \| 99\.4 \(\+10%\) \| 6\.1 \(\u00b10%\) \|/
  );
  assert.match(
    body,
    /\| replay eve-test \(2x\) \| 297 \(\u00b10%\) \| 288 \(\u00b10%\) \| 742 \(\u00b10%\) \| 719 \(\u00b10%\) \|/
  );
  assert.match(body, /\| 141 \(\u00b10%\) \| 10 \|/);
  const streamsSection = body.slice(
    body.indexOf('**Streams**'),
    body.indexOf('</details>')
  );
  assert.doesNotMatch(
    streamsSection,
    /\ud83d\udd34|\ud83d\udfe2|\ud83d\udd3b|\ud83d\udc9a/
  );
  // Detail rows render nowhere.
  assert.doesNotMatch(body, /seq 0 \|/);
  assert.doesNotMatch(body, /write slip/);
  // Drill-down still renders from the stream rows.
  assert.match(body, /\ud83d\udcc8 CRTT drill-down/);
  assert.match(
    body,
    /llm +\u00b7+[\u2581\u2582\u2583\u2584\u2585\u2586\u2587\u2588]*\u2588/
  );
  assert.match(body, /Delivery jitter over stream progress/);
  // CRTT + CDV definitions stay in the legend (stream table columns), and
  // the internal 'stream' id never leaks into it.
  assert.match(body, /\*\*CRTT\*\*: chunk round-trip time/);
  assert.match(body, /\*\*CDV\*\*: chunk delay variation/);
  assert.match(body, /\*\*Streams\*\*: writer\/reader sustained rates/);
  // History block: per-run arrays and sparkline payloads stripped, medians
  // and baseline annotations kept.
  const history = extractHistory(body);
  const kept = history[0].results[0].metrics[0];
  assert.strictEqual(kept.hist, undefined);
  assert.strictEqual(kept.progressAvgMs, undefined);
  assert.strictEqual(kept.stream.runs, undefined);
  assert.strictEqual(kept.stream.wrCps, 100);
  assert.strictEqual(kept.baselineStream.rdCps, 90);
  // Re-render from history keeps the Streams table, drops the drill-down.
  const rerendered = renderComment({
    status: 'running',
    results: [],
    history,
    commit: 'ffffff1234567890',
  });
  assert.match(rerendered, /\| chunk RTT \(llm\) \| 100/);
  assert.doesNotMatch(rerendered, /CRTT drill-down/);
});

test('renders the stream table without deltas when main has no baseline', async () => {
  const { renderComment } = await loadModule();
  const body = renderComment({
    status: 'completed',
    results: [crttResult({ hist: crttHist([[128, 3000]]) })],
    history: [],
    commit: 'abcdef1234567890',
  });
  assert.match(
    body,
    /\| chunk RTT \(llm\) \| 100 \| 99\.4 \| 6\.1 \| 6 \| 96 \| 188 \| 438 \| 1229 \| 141 \| 10 \|/
  );
  assert.doesNotMatch(body, /%\)/);
  assert.match(body, /No `main` baseline yet/);
});

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

  // Collapsed by default — a drill-down, not the headline.
  assert.match(
    body,
    /<details>\n<summary>📈 STSO distribution vs main \(inline \/ queue-hop histograms\)<\/summary>/
  );
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
    /<sub>The collapsed \*\*STSO distribution\*\* section above buckets every/
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

  // Summary drops the "vs main" qualifier when there is nothing to diff.
  assert.match(
    body,
    /<summary>📈 STSO distribution \(inline \/ queue-hop histograms\)<\/summary>/
  );
  assert.doesNotMatch(body, /STSO distribution vs main/);
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
  assert.match(body, /<summary>📈 STSO distribution vs main/);
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
