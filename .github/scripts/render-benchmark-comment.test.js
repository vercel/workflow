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

test('renders the SO metric row and its footer definition', async () => {
  const { renderComment } = await loadModule();
  const result = sampleResult({
    scenarios: [
      {
        name: 'stream overhead',
        description: 'paced LLM-shaped stream, drained',
      },
    ],
    metrics: [
      {
        metric: 'so',
        scenario: 'stream overhead',
        unit: 'ms',
        best: 40,
        avg: 120,
        p75: 110,
        p90: 220,
        p99: 380,
        samples: 30,
        targets: { p75: 250, p90: 500, p99: 1000 },
      },
    ],
  });
  const body = renderComment({
    status: 'completed',
    results: [result],
    history: [],
    commit: 'abcdef1234567890',
  });

  // SO renders as a table row and is defined in the (collapsed) footer.
  assert.match(body, /\| \*\*SO\*\* \| stream overhead \|/);
  assert.match(body, /\*\*SO\*\*: stream overhead/);
  // Within target on every percentile → the SO row carries no 🔴 mark.
  assert.doesNotMatch(body, /\| \*\*SO\*\* \|.*🔴/);
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
