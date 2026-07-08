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
    app: 'nextjs-turbopack',
    backend: 'vercel',
    generatedAt: '2026-07-08T12:00:00.000Z',
    commit: 'abcdef1234567890',
    config: {
      streamIterations: 30,
      sequentialIterations: 5,
      sequentialStepCount: 100,
      warmupIterations: 2,
    },
    metrics: [
      {
        metric: 'ttfs',
        scenario: '1 step + stream (turbo)',
        unit: 'ms',
        avg: 412.3,
        p50: 398,
        p90: 512,
        p99: 634,
        min: 320,
        max: 700,
        samples: 30,
      },
      {
        metric: 'so',
        scenario: '1 step + stream (turbo)',
        unit: 'ms',
        avg: 55.1,
        p50: 50,
        p90: 80,
        p99: 120,
        min: 30,
        max: 130,
        samples: 30,
      },
      {
        metric: 'stso',
        scenario: '100 sequential steps',
        unit: 'ms',
        avg: 91,
        p50: 85,
        p90: 120,
        p99: 200,
        min: 60,
        max: 250,
        samples: 495,
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
  assert.match(body, /1 step \+ stream \(turbo\)/);
  assert.match(body, /398 ms/);
  assert.match(body, /commit `abcdef1`/);
  // No previous results yet
  assert.doesNotMatch(body, /Previous results/);
  // History round-trips through the embedded data block
  const history = extractHistory(body);
  assert.strictEqual(history.length, 1);
  assert.strictEqual(history[0].commit, 'abcdef1234567890');
  assert.strictEqual(history[0].results[0].metrics.length, 3);
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
  assert.match(running, /398 ms/);
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
  assert.match(first, /398 ms/);

  const secondOut = path.join(dir, 'comment2.md');
  execFileSync(process.execPath, [
    SCRIPT,
    '--status',
    'completed',
    '--results-dir',
    resultsDir,
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
