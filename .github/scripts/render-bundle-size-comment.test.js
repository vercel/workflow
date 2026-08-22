const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

// The script is ESM; load it lazily from the CJS test file.
const loadModule = () => import('./render-bundle-size-comment.mjs');

const THRESHOLDS = { pct: 2, bytes: 50 * 1024 };

function fingerprint(overrides = {}) {
  return {
    nodeMajor: '22',
    WORKFLOW_TARGET_WORLD: 'vercel',
    WORKFLOW_SOURCEMAP: 'false',
    WORKFLOW_PUBLIC_MANIFEST: '1',
    ...overrides,
  };
}

function report({ app = 'hono', metrics, fingerprint: fp } = {}) {
  return {
    schemaVersion: 1,
    app,
    commit: 'abc1234',
    fingerprint: fp ?? fingerprint(),
    metrics: metrics ?? [
      {
        id: 'flow-bundle',
        label: 'Flow route bundle',
        tier: 1,
        gated: true,
        raw: 5_000_000,
        gzip: 1_000_000,
      },
      {
        id: 'framework-output',
        label: 'Framework output',
        tier: 2,
        gated: false,
        raw: 3_000_000,
        gzip: 700_000,
      },
    ],
  };
}

function withMetricRaw(base, id, raw) {
  return {
    ...base,
    metrics: base.metrics.map((metric) =>
      metric.id === id ? { ...metric, raw } : metric
    ),
  };
}

function mapOf(...reports) {
  return new Map(reports.map((r) => [r.app, r]));
}

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bundle-size-test-'));
}

test('no baseline renders sizes and gates nothing', async () => {
  const { compareAll, renderComment } = await loadModule();
  const comparison = compareAll(mapOf(report()), new Map(), THRESHOLDS);

  assert.deepStrictEqual(comparison.regressions, []);
  assert.strictEqual(comparison.apps[0].hasBaseline, false);
  assert.strictEqual(comparison.apps[0].rows[0].rawDelta, null);

  const md = renderComment({
    comparison,
    commit: 'abc1234',
    runUrl: 'https://example.test/run',
    thresholds: THRESHOLDS,
  });
  assert.match(md, /No baseline on `main` yet/);
});

test('growth just over the percentage threshold is a regression', async () => {
  const { compareAll } = await loadModule();
  // 2% of 5,000,000 is 100,000, which exceeds the 51,200-byte floor.
  const current = withMetricRaw(report(), 'flow-bundle', 5_100_001);
  const comparison = compareAll(mapOf(current), mapOf(report()), THRESHOLDS);

  assert.strictEqual(comparison.regressions.length, 1);
  assert.strictEqual(comparison.regressions[0].id, 'flow-bundle');
  assert.strictEqual(comparison.regressions[0].rawDelta, 100_001);
});

test('growth exactly at the threshold is not a regression', async () => {
  const { compareAll } = await loadModule();
  const current = withMetricRaw(report(), 'flow-bundle', 5_100_000);
  const comparison = compareAll(mapOf(current), mapOf(report()), THRESHOLDS);

  assert.deepStrictEqual(comparison.regressions, []);
  assert.strictEqual(comparison.apps[0].rows[0].rawDelta, 100_000);
});

test('the absolute floor protects small bundles from percentage noise', async () => {
  const { compareAll } = await loadModule();
  const small = report({
    metrics: [
      {
        id: 'step-registrations',
        label: 'Step registrations',
        tier: 1,
        gated: true,
        raw: 1_000,
        gzip: 400,
      },
    ],
  });
  // +20,000 bytes is 2000% growth, but still under the 51,200-byte floor.
  const current = withMetricRaw(small, 'step-registrations', 21_000);
  const comparison = compareAll(mapOf(current), mapOf(small), THRESHOLDS);

  assert.deepStrictEqual(comparison.regressions, []);
  assert.strictEqual(comparison.apps[0].rows[0].threshold, 51_200);
});

test('a non-gated metric never regresses however much it grows', async () => {
  const { compareAll } = await loadModule();
  const current = withMetricRaw(report(), 'framework-output', 30_000_000);
  const comparison = compareAll(mapOf(current), mapOf(report()), THRESHOLDS);

  assert.deepStrictEqual(comparison.regressions, []);
  const row = comparison.apps[0].rows.find((r) => r.id === 'framework-output');
  assert.strictEqual(row.rawDelta, 27_000_000);
  assert.strictEqual(row.regression, false);
});

test('a fingerprint mismatch suppresses the diff and the gate', async () => {
  const { compareAll, renderComment } = await loadModule();
  const current = {
    ...withMetricRaw(report(), 'flow-bundle', 50_000_000),
    fingerprint: fingerprint({ WORKFLOW_TARGET_WORLD: 'local' }),
  };
  const comparison = compareAll(mapOf(current), mapOf(report()), THRESHOLDS);

  assert.deepStrictEqual(comparison.regressions, []);
  assert.ok(comparison.apps[0].fingerprintMismatch);
  assert.strictEqual(comparison.apps[0].rows[0].rawDelta, null);

  const md = renderComment({
    comparison,
    commit: 'abc1234',
    runUrl: 'https://example.test/run',
    thresholds: THRESHOLDS,
  });
  assert.match(md, /Build fingerprint differs/);
  assert.match(md, /WORKFLOW_TARGET_WORLD/);
});

test('a metric missing from the baseline reports no delta and does not gate', async () => {
  const { compareAll } = await loadModule();
  const baseline = report({
    metrics: report().metrics.filter((m) => m.id !== 'flow-bundle'),
  });
  const comparison = compareAll(mapOf(report()), mapOf(baseline), THRESHOLDS);

  assert.deepStrictEqual(comparison.regressions, []);
  const row = comparison.apps[0].rows.find((r) => r.id === 'flow-bundle');
  assert.strictEqual(row.rawDelta, null);
});

test('an improvement renders as a negative delta', async () => {
  const { compareAll, renderComment } = await loadModule();
  const current = withMetricRaw(report(), 'flow-bundle', 4_000_000);
  const comparison = compareAll(mapOf(current), mapOf(report()), THRESHOLDS);

  assert.deepStrictEqual(comparison.regressions, []);
  const md = renderComment({
    comparison,
    commit: 'abc1234',
    runUrl: 'https://example.test/run',
    thresholds: THRESHOLDS,
  });
  assert.match(md, /-976\.6 KiB \(-20\.00%\)/);
});

test('loadReports skips unparseable and future-schema files', async () => {
  const { loadReports } = await loadModule();
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify(report()));
  fs.writeFileSync(path.join(dir, 'broken.json'), '{not json');
  fs.writeFileSync(
    path.join(dir, 'future.json'),
    JSON.stringify({ ...report({ app: 'other' }), schemaVersion: 99 })
  );

  const { reports, skipped } = loadReports(dir);
  assert.deepStrictEqual([...reports.keys()], ['hono']);
  assert.strictEqual(skipped.length, 2);
});

test('loadReports finds reports nested one artifact-dir deep', async () => {
  // `gh run download` puts each artifact in its own subdirectory, which is how
  // the main baseline arrives; `download-artifact --merge-multiple` flattens.
  const { loadReports } = await loadModule();
  const dir = tmpdir();
  const sub = path.join(dir, 'size-results-hono');
  fs.mkdirSync(sub);
  fs.writeFileSync(
    path.join(sub, 'size-results-hono.json'),
    JSON.stringify(report())
  );

  const { reports } = loadReports(dir);
  assert.deepStrictEqual([...reports.keys()], ['hono']);
});

test('loadReports treats a missing directory as no baseline', async () => {
  const { loadReports } = await loadModule();
  const { reports, skipped } = loadReports(
    path.join(tmpdir(), 'does-not-exist')
  );
  assert.strictEqual(reports.size, 0);
  assert.deepStrictEqual(skipped, []);
});

test('the comment flags regressions and names the override label', async () => {
  const { compareAll, renderComment } = await loadModule();
  const current = withMetricRaw(report(), 'flow-bundle', 6_000_000);
  const comparison = compareAll(mapOf(current), mapOf(report()), THRESHOLDS);

  const md = renderComment({
    comparison,
    commit: 'abc1234',
    runUrl: 'https://example.test/run',
    thresholds: THRESHOLDS,
  });
  assert.match(md, /1 gated bundle\(s\) grew past the threshold/);
  assert.match(md, /allow-bundle-size-growth/);
  assert.match(md, /⚠️/);
});

test('renderComment reports a failed measurement run', async () => {
  const { compareAll, renderComment } = await loadModule();
  const md = renderComment({
    comparison: compareAll(new Map(), new Map(), THRESHOLDS),
    commit: 'abc1234',
    runUrl: 'https://example.test/run',
    status: 'failed',
    thresholds: THRESHOLDS,
  });
  assert.match(md, /No measurements were produced/);
});

test('parseArgs rejects a negative threshold', async () => {
  const { parseArgs } = await loadModule();
  assert.throws(
    () =>
      parseArgs([
        '--results-dir',
        'a',
        '--output',
        'b',
        '--threshold-pct',
        '-1',
      ]),
    /non-negative/
  );
});

test('formatBytes switches units and keeps the sign in deltas', async () => {
  const { formatBytes, formatDelta } = await loadModule();
  assert.strictEqual(formatBytes(512), '512 B');
  assert.strictEqual(formatBytes(2048), '2.0 KiB');
  assert.strictEqual(formatBytes(5 * 1024 * 1024), '5.00 MiB');
  assert.strictEqual(formatDelta(0, 100), 'no change');
  assert.strictEqual(formatDelta(null, 100), '—');
  assert.strictEqual(formatDelta(1024, 102400), '+1.0 KiB (+1.00%)');
});
