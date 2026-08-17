const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  gatingOutcomes,
  summaryColumns,
  regressionCount,
  infraCount,
  countColumn,
  buildEntry,
  summarize,
  maxHistoryRuns,
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

function runRender(file) {
  return execFileSync('node', [SCRIPT, file], { encoding: 'utf8' });
}

// The CI shape: several lanes rendered into one comment, with the previous
// comment (if any) supplying the history.
function runRenderLanes(lanes, { previousComment, timestamp, runUrl } = {}) {
  const args = [SCRIPT];
  for (const [name, file] of Object.entries(lanes)) {
    args.push('--lane', `${name}=${file}`);
  }
  args.push(
    '--run-url',
    runUrl ?? 'https://github.com/vercel/workflow/actions/runs/1',
    '--run-attempt',
    '1',
    '--timestamp',
    timestamp ?? '2026-08-14T17:08:21Z'
  );
  if (previousComment !== undefined) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repro-previous-'));
    const file = path.join(dir, 'previous.md');
    fs.writeFileSync(file, previousComment);
    args.push('--previous-comment', file);
  }
  return execFileSync('node', args, { encoding: 'utf8' });
}

function tableRows(output, heading) {
  const section = (output.split(`### ${heading}`)[1] ?? '').split('\n### ')[0];
  return section
    .split('\n')
    .filter((line) => line.startsWith('|'))
    .slice(2); // drop the header and the alignment row
}

function resultsFor(distribution) {
  return {
    results: Object.entries(distribution).flatMap(([outcome, count]) =>
      Array.from({ length: count }, (_, index) => ({
        attempt: index,
        scenario: 'step-storm',
        outcome,
        errorCode: outcome === 'completed' ? undefined : outcome,
        runId: `wrun_${outcome}_${index}`,
      }))
    ),
  };
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

test('buildEntry carries partial-run metadata through to the summary', () => {
  const entry = buildEntry({
    partial: true,
    budgetExhausted: true,
    plannedAttempts: 1400,
    results: [{ outcome: 'completed' }, { outcome: 'CORRUPTED_EVENT_LOG' }],
  });
  assert.strictEqual(entry.missingResults, false);
  assert.strictEqual(entry.partial, true);
  assert.strictEqual(entry.budgetExhausted, true);
  assert.strictEqual(entry.plannedAttempts, 1400);
  assert.strictEqual(entry.total, 2);
});

test('buildEntry defaults a complete file to non-partial', () => {
  const entry = buildEntry({ results: [{ outcome: 'completed' }] });
  assert.strictEqual(entry.partial, false);
  assert.strictEqual(entry.budgetExhausted, false);
  assert.strictEqual(entry.plannedAttempts, 0);
});

test('a partial result file renders as partial, not as a missing file', () => {
  const file = writeTempResults({
    partial: true,
    budgetExhausted: true,
    plannedAttempts: 1400,
    results: [{ outcome: 'completed' }, { outcome: 'CORRUPTED_EVENT_LOG' }],
  });
  const output = runRender(file);
  assert.ok(!output.includes('No result file was produced'));
  assert.ok(output.includes('partial'));
  assert.ok(output.includes('1400'));
});

test('--check still gates on regressions in a partial result file', () => {
  const file = writeTempResults({
    partial: true,
    budgetExhausted: true,
    plannedAttempts: 1400,
    results: [{ outcome: 'completed' }, { outcome: 'CORRUPTED_EVENT_LOG' }],
  });
  assert.strictEqual(runCheck(file), 1);
});

test('the four count columns always add up to Total', () => {
  // Whatever bucket an outcome lands in, no run may go missing between the
  // outcome list and the table — `infra` included.
  const distribution = {
    completed: 3,
    CORRUPTED_EVENT_LOG: 2,
    USER_ERROR: 1,
    RUNTIME_ERROR: 1,
    stuck: 4,
    other: 1,
    infra: 5,
  };
  const columnTotal = summaryColumns.reduce(
    (sum, column) => sum + countColumn(distribution, column),
    0
  );
  assert.strictEqual(columnTotal, 17);
  assert.strictEqual(buildEntry(resultsFor(distribution)).total, 17);
});

test('lanes render as one row each under a single run', () => {
  const output = runRenderLanes({
    vercel: writeTempResults(resultsFor({ completed: 14 })),
    local: writeTempResults(
      resultsFor({ completed: 8, CORRUPTED_EVENT_LOG: 6 })
    ),
    postgres: writeTempResults(
      resultsFor({ completed: 9, CORRUPTED_EVENT_LOG: 4, stuck: 1 })
    ),
  });

  const rows = tableRows(output, 'Run History');
  assert.strictEqual(rows.length, 3, 'one row per lane, not per metric');
  // Columns: Run, Lane, Total, Complete, Corrupt, Stuck, Other.
  assert.ok(output.includes('| Run | Lane | Total | Complete | Corrupt |'));
  assert.match(rows[0], /\| vercel \| 14 \| 14 \| 0 \| 0 \| 0 \|$/);
  assert.match(rows[1], /\| local \| 14 \| 8 \| 6 \| 0 \| 0 \|$/);
  assert.match(rows[2], /\| postgres \| 14 \| 9 \| 4 \| 1 \| 0 \|$/);
  // The run is stamped once and its lane rows hang off it.
  assert.ok(rows[0].includes('08-14 17:08'));
  assert.ok(!rows[1].includes('08-14 17:08'));

  // Per-lane verdicts, and no scenario breakdown.
  assert.ok(output.includes('- `local` **6/14 regressions** — 6 corrupt'));
  assert.ok(output.includes('- `vercel` clean, 14 runs'));
  assert.ok(!output.includes('Scenario Breakdown'));
});

test('a lane with no result file gets a row instead of breaking the render', () => {
  const output = runRenderLanes({
    vercel: path.join(os.tmpdir(), 'does-not-exist-repro-results.json'),
    local: writeTempResults(resultsFor({ completed: 14 })),
  });
  const rows = tableRows(output, 'Run History');
  assert.strictEqual(rows.length, 2);
  assert.match(rows[0], /\| vercel \| – \| – \| – \| – \| – \|$/);
  // A missing file says only that: the lane may have died before the harness
  // ever ran, so the line must not claim the harness did anything.
  assert.ok(output.includes('- `vercel` no results'));
  assert.ok(!output.includes('harness died'));
});

test('history accumulates per lane across runs and stays capped', () => {
  const lanes = {
    vercel: writeTempResults(resultsFor({ completed: 14 })),
    local: writeTempResults(
      resultsFor({ completed: 8, CORRUPTED_EVENT_LOG: 6 })
    ),
  };

  let comment = '';
  const runCount = maxHistoryRuns + 2;
  for (let index = 0; index < runCount; index += 1) {
    comment = runRenderLanes(lanes, {
      previousComment: comment,
      runUrl: `https://github.com/vercel/workflow/actions/runs/${index}`,
      timestamp: `2026-08-14T1${index}:00:00Z`,
    });
  }

  const rows = tableRows(comment, 'Run History');
  assert.strictEqual(
    rows.length,
    maxHistoryRuns * 2,
    'both lanes are kept for each of the retained runs'
  );
  // Oldest runs are dropped, newest is last.
  assert.ok(!comment.includes('08-14 10:00'));
  assert.ok(rows[rows.length - 2].includes(`08-14 1${runCount - 1}:00`));
  // Only the newest run keeps its per-run detail in the stored history.
  const history = JSON.parse(
    comment.split('<!-- event-log-race-repro-history\n')[1].split('\n')[0]
  );
  assert.strictEqual(history.runs.length, maxHistoryRuns);
  assert.strictEqual(history.runs[0].lanes.local.failing.length, 0);
  assert.strictEqual(history.runs[0].lanes.local.config, undefined);
  assert.strictEqual(
    history.runs[history.runs.length - 1].lanes.local.failing.length,
    6
  );
});

test('a pre-lane comment history is adopted as the Vercel lane', () => {
  // The three lanes used to post three comments, each storing a bare array of
  // its own runs. The combined comment inherits the Vercel lane's array (that
  // comment's marker is the one it reuses) rather than starting from scratch.
  const legacyComment = [
    '<!-- event-log-race-repro-results -->',
    '## Event Log Race Repro',
    '',
    '<!-- event-log-race-repro-history',
    JSON.stringify([
      {
        timestamp: '2026-08-13T09:00:00Z',
        runAttempt: '1',
        runUrl: 'https://github.com/vercel/workflow/actions/runs/0',
        distribution: { completed: 13, CORRUPTED_EVENT_LOG: 1 },
        failedCount: 1,
        total: 14,
      },
    ]),
    'event-log-race-repro-history -->',
  ].join('\n');

  const output = runRenderLanes(
    {
      vercel: writeTempResults(resultsFor({ completed: 14 })),
      local: writeTempResults(resultsFor({ completed: 14 })),
    },
    { previousComment: legacyComment }
  );

  const rows = tableRows(output, 'Run History');
  // The legacy run (Vercel only) plus this run's two lanes.
  assert.strictEqual(rows.length, 3);
  assert.ok(rows[0].includes('08-13 09:00'));
  assert.match(rows[0], /\| vercel \| 14 \| 13 \| 1 \| 0 \| 0 \|$/);
});

test('non-completed rows name the error code only when it adds something', () => {
  const file = writeTempResults({
    results: [
      {
        attempt: 1,
        scenario: 'hook-storm',
        outcome: 'CORRUPTED_EVENT_LOG',
        errorCode: 'CORRUPTED_EVENT_LOG',
        runId: 'wrun_corrupt',
      },
      {
        attempt: 2,
        scenario: 'hook-sleep',
        outcome: 'infra',
        errorCode: 'HOOK_RESUME_FAILED',
        runId: 'wrun_infra',
      },
    ],
  });
  const rows = tableRows(runRender(file), 'Latest Non-Completed Runs');
  assert.match(rows[0], /\| CORRUPTED_EVENT_LOG \| wrun_corrupt \|$/);
  assert.match(rows[1], /\| infra \(HOOK_RESUME_FAILED\) \| wrun_infra \|$/);
});

test('a flood of infra rows cannot crowd out the regressions', () => {
  // Soak shape: four figures of harness-timing `infra` outcomes around a
  // handful of real ones. Every regression is listed; the infra rows are there
  // to name the error code, not to be read.
  const entry = buildEntry({
    results: [
      ...Array.from({ length: 1231 }, (_, i) => ({
        attempt: i,
        outcome: 'infra',
        errorCode: 'HOOK_RESUME_FAILED',
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        attempt: 5000 + i,
        outcome: 'CORRUPTED_EVENT_LOG',
        errorCode: 'CORRUPTED_EVENT_LOG',
      })),
    ],
  });
  const listedInfra = entry.failing.filter((r) => r.outcome === 'infra');
  assert.strictEqual(
    entry.failing.length - listedInfra.length,
    4,
    'every regression is listed'
  );
  assert.ok(listedInfra.length > 0 && listedInfra.length <= 3);
  assert.strictEqual(
    entry.failing.length + entry.truncatedFailingCount,
    1235,
    'the truncation note accounts for every non-completed run'
  );
});

test('a local render omits the comment marker and the stored history', () => {
  // No --run-url: this is the local runner printing to a terminal, where the
  // sticky marker and the history JSON are just noise.
  const output = runRender(writeTempResults(resultsFor({ completed: 2 })));
  assert.ok(!output.includes('<!-- event-log-race-repro'));
  assert.ok(!output.includes('"runs":'));
  assert.ok(output.includes('### Run History'));
});

test('the poke ceiling is rendered next to the cadence it bounds', () => {
  // The cap binds on the local lanes — every step-storm run there reaches it —
  // so a config line naming only `poke 750ms` would advertise a run-long
  // stream of out-of-band writes that the run did not receive. A number that
  // silently truncates coverage has to appear next to the numbers it truncates.
  const withCap = runRender(
    writeTempResults({
      ...resultsFor({ completed: 14 }),
      config: { attempts: 14, pokeIntervalMs: 750, pokeMax: 64 },
    })
  );
  assert.ok(withCap.includes('poke 750ms / poke max 64'));

  // Absent from an older history row's config, it renders nothing rather than
  // an invented ceiling.
  const withoutCap = runRender(
    writeTempResults({
      ...resultsFor({ completed: 14 }),
      config: { attempts: 14, pokeIntervalMs: 750 },
    })
  );
  assert.ok(withoutCap.includes('poke 750ms'));
  assert.ok(!withoutCap.includes('poke max'));
});
