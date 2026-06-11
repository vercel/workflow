const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  gatingOutcomes,
  regressionCount,
  infraCount,
  buildEntry,
  summarize,
} = require('./render-event-log-race-repro-results.js');

const SCRIPT = path.join(__dirname, 'render-event-log-race-repro-results.js');

function writeTempResults(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-render-'));
  const file = path.join(dir, 'event-log-race-repro-results.json');
  fs.writeFileSync(file, JSON.stringify(contents));
  return file;
}

function runCheck(file) {
  try {
    execFileSync('node', [SCRIPT, file, '--check'], { stdio: 'ignore' });
    return 0;
  } catch (err) {
    return err.status ?? 1;
  }
}

test('infra is not a gating outcome', () => {
  assert.ok(!gatingOutcomes.includes('infra'));
  assert.ok(!gatingOutcomes.includes('completed'));
  assert.ok(gatingOutcomes.includes('CORRUPTED_EVENT_LOG'));
  assert.ok(gatingOutcomes.includes('stuck'));
});

test('regressionCount ignores completed and infra', () => {
  const distribution = {
    completed: 1000,
    CORRUPTED_EVENT_LOG: 0,
    USER_ERROR: 0,
    RUNTIME_ERROR: 0,
    stuck: 0,
    other: 0,
    infra: 1231,
  };
  assert.strictEqual(regressionCount(distribution), 0);
  assert.strictEqual(infraCount(distribution), 1231);
});

test('regressionCount counts real corruption-class outcomes', () => {
  const distribution = {
    completed: 10,
    CORRUPTED_EVENT_LOG: 2,
    USER_ERROR: 0,
    RUNTIME_ERROR: 1,
    stuck: 3,
    other: 1,
    infra: 50,
  };
  // 2 + 1 + 3 + 1 = 7 regressions; the 50 infra runs do not count.
  assert.strictEqual(regressionCount(distribution), 7);
});

test('buildEntry treats an all-infra run as zero regressions', () => {
  // Mirrors the production comment: a flood of HOOK_RESUME_FAILED infra
  // outcomes and not a single corruption-class failure.
  const results = [
    ...Array.from({ length: 769 }, (_, i) => ({
      attempt: i,
      scenario: 'hook-sleep',
      outcome: 'completed',
      status: 'completed',
    })),
    ...Array.from({ length: 1231 }, (_, i) => ({
      attempt: i,
      scenario: 'hook-sleep',
      outcome: 'infra',
      status: 'completed',
      errorCode: 'HOOK_RESUME_FAILED',
    })),
  ];
  const entry = buildEntry({ results });
  assert.strictEqual(entry.failedCount, 0, 'no regressions should be counted');
  assert.strictEqual(entry.infraCount, 1231);
  assert.strictEqual(entry.total, 2000);
  // Regressions sort ahead of infra so they are never truncated away.
  assert.ok(entry.failing.every((r) => r.outcome === 'infra'));
});

test('buildEntry surfaces regressions ahead of infra rows', () => {
  const results = [
    ...Array.from({ length: 30 }, (_, i) => ({
      attempt: i,
      scenario: 'hook-sleep',
      outcome: 'infra',
      errorCode: 'HOOK_RESUME_FAILED',
    })),
    {
      attempt: 999,
      scenario: 'step-fanout',
      outcome: 'CORRUPTED_EVENT_LOG',
      errorCode: 'CORRUPTED_EVENT_LOG',
    },
  ];
  const entry = buildEntry({ results });
  assert.strictEqual(entry.failedCount, 1);
  assert.strictEqual(
    entry.failing[0].outcome,
    'CORRUPTED_EVENT_LOG',
    'regression must appear first despite being last in the input'
  );
});

test('summarize buckets infra outcomes', () => {
  const distribution = summarize([
    { outcome: 'completed' },
    { outcome: 'infra' },
    { outcome: 'infra' },
    { outcome: 'CORRUPTED_EVENT_LOG' },
  ]);
  assert.strictEqual(distribution.infra, 2);
  assert.strictEqual(distribution.completed, 1);
  assert.strictEqual(distribution.CORRUPTED_EVENT_LOG, 1);
});

test('--check exits 0 when only infra outcomes are present', () => {
  const file = writeTempResults({
    results: [
      { outcome: 'completed' },
      { outcome: 'infra', errorCode: 'HOOK_RESUME_FAILED' },
      { outcome: 'infra', errorCode: 'NO_WAKE_BRANCH' },
    ],
  });
  assert.strictEqual(runCheck(file), 0);
});

test('--check exits 1 on a corruption-class regression', () => {
  const file = writeTempResults({
    results: [
      { outcome: 'completed' },
      { outcome: 'infra', errorCode: 'HOOK_RESUME_FAILED' },
      { outcome: 'CORRUPTED_EVENT_LOG', errorCode: 'CORRUPTED_EVENT_LOG' },
    ],
  });
  assert.strictEqual(runCheck(file), 1);
});
