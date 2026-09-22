const assert = require('node:assert/strict');
const { test } = require('node:test');

const {
  PROJECT,
  OBSERVATION_STARTED_AT,
  normalizeDeployment,
  reconcile,
  renderMarkdown,
} = require('./reconcile-vercel-deployment-dispatches.js');

const FROM = OBSERVATION_STARTED_AT;
const TO = Date.parse('2026-09-24T00:00:00Z');
const SHA = '1234567890abcdef1234567890abcdef12345678';

function deployment(overrides = {}) {
  return {
    uid: 'dpl_one',
    url: 'example-nextjs-workflow-turbopack-one.labs.vercel.dev',
    source: 'git',
    target: 'production',
    readyState: 'READY',
    ready: Date.parse('2026-09-23T12:00:00Z'),
    createdAt: Date.parse('2026-09-23T11:58:00Z'),
    meta: {
      githubCommitSha: SHA,
      githubCommitRef: 'main',
    },
    ...overrides,
  };
}

function observation(overrides = {}) {
  return {
    schemaVersion: 1,
    observedAt: '2026-09-23T12:00:04.000Z',
    project: PROJECT,
    deployment: {
      id: 'dpl_one',
      environment: 'production',
      state: { type: 'success' },
    },
    git: { sha: SHA, ref: 'main', shortSha: SHA.slice(0, 7) },
    github: { runId: '101' },
    ...overrides,
  };
}

function result({
  deployments = [deployment()],
  observations = [observation()],
  runs,
} = {}) {
  return reconcile({
    deployments,
    observations,
    runs: runs || [
      {
        databaseId: 101,
        createdAt: '2026-09-23T12:00:03.000Z',
      },
    ],
    from: FROM,
    to: TO,
  });
}

test('matches a dispatch observation to its Vercel deployment', () => {
  const report = result();
  assert.deepEqual(report.counts, {
    deployments: 1,
    observed: 1,
    missing: 0,
    duplicate: 0,
    mismatched: 0,
    unexpected: 0,
    unmatchable: 0,
    artifactDownloadFailures: 0,
  });
  assert.deepEqual(report.latencyMs, {
    samples: 1,
    p50: 3000,
    p95: 3000,
    max: 3000,
  });
});

test('matches multiple deployments of one SHA independently', () => {
  const secondDeployment = deployment({
    uid: 'dpl_two',
    url: 'example-nextjs-workflow-turbopack-two.labs.vercel.dev',
    target: null,
    ready: Date.parse('2026-09-23T12:01:00Z'),
    meta: { githubCommitSha: SHA, githubCommitRef: 'HEAD' },
  });
  const secondObservation = observation({
    deployment: {
      id: 'dpl_two',
      environment: 'preview',
      state: { type: 'success' },
    },
    git: { sha: SHA, ref: 'HEAD', shortSha: SHA.slice(0, 7) },
    github: { runId: '102' },
  });
  const report = result({
    deployments: [deployment(), secondDeployment],
    observations: [observation(), secondObservation],
    runs: [
      { databaseId: 101, createdAt: '2026-09-23T12:00:03.000Z' },
      { databaseId: 102, createdAt: '2026-09-23T12:01:04.000Z' },
    ],
  });
  assert.equal(report.counts.deployments, 2);
  assert.equal(report.counts.observed, 2);
  assert.equal(report.counts.missing, 0);
});

test('reports a missing dispatch', () => {
  const report = result({ observations: [] });
  assert.equal(report.counts.missing, 1);
  assert.equal(report.missing[0].id, 'dpl_one');
});

test('reports duplicate observations without double-counting deployments', () => {
  const duplicate = observation({
    observedAt: '2026-09-23T12:00:06.000Z',
    github: { runId: '102' },
  });
  const report = result({
    observations: [observation(), duplicate],
    runs: [
      { databaseId: 101, createdAt: '2026-09-23T12:00:03.000Z' },
      { databaseId: 102, createdAt: '2026-09-23T12:00:05.000Z' },
    ],
  });
  assert.equal(report.counts.observed, 1);
  assert.equal(report.counts.duplicate, 1);
  assert.deepEqual(report.duplicates[0].runIds, ['101', '102']);
});

test('reports identity mismatches', () => {
  const mismatched = observation({
    deployment: {
      id: 'dpl_one',
      environment: 'preview',
      state: { type: 'error' },
    },
    git: { sha: SHA, ref: 'another-branch', shortSha: SHA.slice(0, 7) },
  });
  const report = result({ observations: [mismatched] });
  assert.equal(report.counts.mismatched, 1);
  assert.deepEqual(
    report.mismatched[0].differences.map((entry) => entry.field),
    ['deployment.environment', 'deployment.state.type', 'git.ref']
  );
});

test('reports observations without a deployment id and unknown deployments', () => {
  const noId = observation({
    deployment: { environment: 'production', state: { type: 'error' } },
    github: { runId: '103' },
  });
  const unknown = observation({
    deployment: {
      id: 'dpl_unknown',
      environment: 'production',
      state: { type: 'success' },
    },
    github: { runId: '104' },
  });
  const report = result({ observations: [noId, unknown] });
  assert.equal(report.counts.missing, 1);
  assert.equal(report.counts.unexpected, 1);
  assert.equal(report.counts.unmatchable, 1);
});

test('surfaces artifact download failures separately from missing dispatches', () => {
  const report = reconcile({
    deployments: [deployment()],
    observations: [],
    runs: [],
    downloadFailures: ['101'],
    from: FROM,
    to: TO,
  });
  assert.equal(report.counts.missing, 1);
  assert.equal(report.counts.artifactDownloadFailures, 1);
  assert.deepEqual(report.artifactDownloadFailures, ['101']);
});

test('does not count deployments from before observation began', () => {
  const report = reconcile({
    deployments: [
      deployment({ ready: OBSERVATION_STARTED_AT - 1 }),
      deployment({ uid: 'dpl_after', ready: OBSERVATION_STARTED_AT }),
    ],
    observations: [],
    runs: [],
    from: OBSERVATION_STARTED_AT - 86_400_000,
    to: OBSERVATION_STARTED_AT + 86_400_000,
  });
  assert.equal(report.counts.deployments, 1);
  assert.equal(
    report.window.from,
    new Date(OBSERVATION_STARTED_AT).toISOString()
  );
});

test('ignores CLI deployments because they do not emit Git repository dispatches', () => {
  const report = result({
    deployments: [
      deployment({
        source: 'cli',
        meta: { githubCommitSha: SHA, githubCommitRef: 'HEAD' },
      }),
    ],
    observations: [],
  });
  assert.equal(report.counts.deployments, 0);
});

test('ignores non-terminal and out-of-window deployments', () => {
  const report = result({
    deployments: [
      deployment({ uid: 'dpl_building', readyState: 'BUILDING' }),
      deployment({
        uid: 'dpl_old',
        ready: Date.parse('2026-09-19T12:00:00Z'),
      }),
    ],
    observations: [],
  });
  assert.equal(report.counts.deployments, 0);
});

test('normalizes preview and terminal Vercel states', () => {
  assert.deepEqual(
    normalizeDeployment(
      deployment({ target: null, readyState: 'ERROR', ready: FROM })
    ),
    {
      id: 'dpl_one',
      project: PROJECT,
      url: 'https://example-nextjs-workflow-turbopack-one.labs.vercel.dev',
      environment: 'preview',
      state: 'error',
      terminalAt: '2026-09-22T16:11:01.000Z',
      git: { sha: SHA, ref: 'main' },
    }
  );
  assert.equal(
    normalizeDeployment(deployment({ readyState: 'BUILDING' })),
    undefined
  );
});

test('renders missing observations without gating the report', () => {
  const markdown = renderMarkdown(result({ observations: [] }));
  assert.match(markdown, /\| 1 \| 0 \| 1 \|/);
  assert.match(markdown, /### Missing dispatches/);
  assert.match(markdown, /dpl_one/);
});
