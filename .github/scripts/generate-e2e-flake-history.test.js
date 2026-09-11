const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  buildHistory,
  dimensionFor,
} = require('./generate-e2e-flake-history.js');

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-flake-history-'));
}

function writeReport(dir, name, assertions, flaky = []) {
  const report = path.join(dir, name);
  fs.writeFileSync(
    report,
    JSON.stringify({
      testResults: [
        {
          name: '/repo/packages/core/e2e/e2e.test.ts',
          assertionResults: assertions.map(([fullName, status]) => ({
            title: fullName.replace(/^e2e /, ''),
            fullName,
            status,
          })),
        },
      ],
    })
  );
  fs.writeFileSync(
    report.replace(/\.json$/, '.flaky.json'),
    JSON.stringify(
      flaky.map((fullName) => ({
        file: '/repo/packages/core/e2e/e2e.test.ts',
        fullName,
        testName: fullName.replace(/^e2e /, ''),
        retryCount: 1,
      }))
    )
  );
}

function options(dir, runId, previous = null) {
  return {
    resultsDir: dir,
    previous,
    output: path.join(dir, 'out.json'),
    runId: String(runId),
    attempt: '1',
    sha: `sha-${runId}`,
    startedAt: `2026-09-${String(runId).padStart(2, '0')}T00:00:00Z`,
    runUrl: `https://github.test/runs/${runId}`,
  };
}

function observation(history, testName) {
  const testIndex = history.tests.findIndex((entry) => entry.name === testName);
  return history.series.find((entry) => entry[1] === testIndex);
}

test('parses lane dimensions without losing hyphenated app names', () => {
  assert.deepStrictEqual(
    dimensionFor('e2e-local-postgres-nextjs-turbopack-canary-quickjs.json'),
    {
      lane: 'local-postgres',
      app: 'nextjs-turbopack',
      world: 'postgres',
      vm: 'quickjs',
      platform: 'linux',
      variant: 'canary',
    }
  );
  assert.deepStrictEqual(
    dimensionFor('e2e-local-dev-tanstack-start-quickjs.json'),
    {
      lane: 'local-dev',
      app: 'tanstack-start',
      world: 'local',
      vm: 'quickjs',
      platform: 'linux',
    }
  );
  assert.deepStrictEqual(dimensionFor('e2e-community-turso-dev.json'), {
    lane: 'community-dev',
    app: 'turso',
    world: 'turso',
    vm: 'node',
    platform: 'linux',
  });
  assert.deepStrictEqual(
    dimensionFor('e2e-vercel-http-transport-tanstack-start.json'),
    {
      lane: 'vercel-http-transport',
      app: 'tanstack-start',
      world: 'vercel',
      vm: 'node',
      platform: 'vercel',
      variant: 'http',
    }
  );
});

test('records executed denominators, excludes skips, and pairs retry data', () => {
  const dir = tempDir();
  writeReport(
    dir,
    'e2e-windows-nextjs-turbopack-node.json',
    [
      ['e2e passes first try', 'passed'],
      ['e2e passes on retry', 'passed'],
      ['e2e final failure', 'failed'],
      ['e2e skipped', 'pending'],
    ],
    ['e2e passes on retry', 'e2e final failure']
  );
  const history = buildHistory(options(dir, 1));

  assert.strictEqual(history.runs.length, 1);
  assert.deepStrictEqual(
    observation(history, 'e2e passes first try').slice(2),
    [1, 0, '1', '0']
  );
  assert.deepStrictEqual(observation(history, 'e2e passes on retry').slice(2), [
    1,
    1,
    '1',
    '1',
  ]);
  assert.deepStrictEqual(observation(history, 'e2e final failure').slice(2), [
    1,
    0,
    '1',
    '0',
  ]);
  assert.strictEqual(observation(history, 'e2e skipped'), undefined);
});

test('rejects corrupt prior masks before decoding them', () => {
  const dir = tempDir();
  writeReport(dir, 'e2e-vercel-prod-vite-node.json', [['e2e test', 'passed']]);
  const previousFile = path.join(dir, 'previous.json');
  fs.writeFileSync(
    previousFile,
    JSON.stringify({
      schemaVersion: 1,
      runs: [
        { id: '1.1', runId: 1, attempt: 1, startedAt: '2026-09-01T00:00:00Z' },
      ],
      dimensions: [{ lane: 'x', app: 'x', world: 'x', vm: 'x', platform: 'x' }],
      tests: [{ file: 'x', name: 'x' }],
      series: [null],
    })
  );
  assert.throws(
    () => buildHistory(options(dir, 2, previousFile)),
    /unsupported or corrupt schema/
  );
});

test('keeps same-app lanes and VMs as distinct series', () => {
  const dir = tempDir();
  writeReport(
    dir,
    'e2e-vercel-prod-vite-node.json',
    [['e2e test', 'passed']],
    ['e2e test']
  );
  writeReport(
    dir,
    'e2e-vercel-prod-vite-quickjs.json',
    [['e2e test', 'passed']],
    []
  );
  const history = buildHistory(options(dir, 1));
  assert.strictEqual(history.dimensions.length, 2);
  assert.strictEqual(history.series.length, 2);
  assert.deepStrictEqual(
    history.series.map((entry) => entry[3]).sort(),
    [0, 1]
  );
});

test('skips malformed and oversized pairs while retaining valid reports', () => {
  const dir = tempDir();
  writeReport(dir, 'e2e-vercel-prod-vite-node.json', [['e2e valid', 'passed']]);
  fs.writeFileSync(
    path.join(dir, 'e2e-vercel-prod-hono-node.json'),
    JSON.stringify({ testResults: [null] })
  );
  fs.writeFileSync(
    path.join(dir, 'e2e-vercel-prod-hono-node.flaky.json'),
    '[]'
  );
  fs.writeFileSync(
    path.join(dir, 'e2e-vercel-prod-express-node.json'),
    `${' '.repeat(2 * 1024 * 1024)}\n`
  );
  fs.writeFileSync(
    path.join(dir, 'e2e-vercel-prod-express-node.flaky.json'),
    '[]'
  );

  const history = buildHistory(options(dir, 1));
  assert.strictEqual(history.dimensions.length, 1);
  assert.deepStrictEqual(observation(history, 'e2e valid').slice(2, 4), [1, 0]);
});

test('orders equal timestamps by numeric run and attempt', () => {
  const dir = tempDir();
  writeReport(dir, 'e2e-vercel-prod-vite-node.json', [['e2e test', 'passed']]);
  const previous = {
    schemaVersion: 1,
    retentionRuns: 30,
    generatedAt: '2026-09-01T00:00:00Z',
    runs: [
      {
        id: '123.10',
        runId: 123,
        attempt: 10,
        sha: 'a',
        startedAt: '2026-09-01T00:00:00Z',
        url: '',
      },
      {
        id: '122.1',
        runId: 122,
        attempt: 1,
        sha: 'b',
        startedAt: '2026-09-01T00:00:00Z',
        url: '',
      },
    ],
    dimensions: [],
    tests: [],
    series: [],
  };
  const previousFile = path.join(dir, 'previous.json');
  fs.writeFileSync(previousFile, JSON.stringify(previous));
  const history = buildHistory({
    ...options(dir, 123, previousFile),
    attempt: '2',
    startedAt: '2026-09-01T00:00:00Z',
  });
  assert.deepStrictEqual(
    history.runs.map((run) => run.id),
    ['122.1', '123.2', '123.10']
  );
});

test('carries history forward, upserts reruns, and caps at 30 runs', () => {
  let previous = null;
  for (let runId = 1; runId <= 32; runId++) {
    const dir = tempDir();
    writeReport(
      dir,
      'e2e-vercel-prod-vite-node.json',
      [['e2e recurring', 'passed']],
      runId % 2 === 0 ? ['e2e recurring'] : []
    );
    const previousFile = previous ? path.join(dir, 'previous.json') : null;
    if (previousFile) fs.writeFileSync(previousFile, JSON.stringify(previous));
    previous = buildHistory(options(dir, runId, previousFile));
  }

  assert.strictEqual(previous.runs.length, 30);
  assert.strictEqual(previous.runs[0].runId, 3);
  assert.strictEqual(previous.runs.at(-1).runId, 32);
  assert.deepStrictEqual(
    observation(previous, 'e2e recurring').slice(2, 4),
    [30, 15]
  );

  const dir = tempDir();
  writeReport(
    dir,
    'e2e-vercel-prod-vite-node.json',
    [['e2e recurring', 'passed']],
    []
  );
  const previousFile = path.join(dir, 'previous.json');
  fs.writeFileSync(previousFile, JSON.stringify(previous));
  const rerun = buildHistory({
    ...options(dir, 32, previousFile),
    attempt: '1',
  });
  assert.strictEqual(rerun.runs.length, 30);
  assert.deepStrictEqual(
    observation(rerun, 'e2e recurring').slice(2, 4),
    [30, 14]
  );
});
