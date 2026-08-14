#!/usr/bin/env node

const fs = require('node:fs');

const args = process.argv.slice(2);
let resultsPath = '';
let runUrl = '';
let previousCommentPath = '';
let timestamp = new Date().toISOString();
let runAttempt = '';
let check = false;
// Which lane a single-file render belongs to (e.g. `world-local`,
// `world-postgres`). It only names the heading and the lane's history bucket;
// the Vercel lane passes no label. The CI comment is rendered once for all
// lanes at a time (see `--lane` below), so this is now the per-job step summary
// and the local runner's path.
let label = '';
// Lanes to render together, as `--lane <name>=<results.json>` pairs, in display
// order. This is how the aggregating job turns three parallel jobs into one PR
// comment: one comment means one history, so the trend for all three worlds
// lines up on the same rows instead of living in three separate sticky
// comments. A lane whose file is missing still gets a row — a lane that
// produced nothing is a fact worth showing, not a gap.
const laneArgs = [];

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--run-url' && args[index + 1]) {
    runUrl = args[index + 1];
    index += 1;
  } else if (arg === '--previous-comment' && args[index + 1]) {
    previousCommentPath = args[index + 1];
    index += 1;
  } else if (arg === '--timestamp' && args[index + 1]) {
    timestamp = args[index + 1];
    index += 1;
  } else if (arg === '--run-attempt' && args[index + 1]) {
    runAttempt = args[index + 1];
    index += 1;
  } else if (arg === '--label' && args[index + 1]) {
    label = args[index + 1];
    index += 1;
  } else if (arg === '--lane' && args[index + 1]) {
    const value = args[index + 1];
    const separator = value.indexOf('=');
    if (separator > 0) {
      laneArgs.push({
        name: value.slice(0, separator),
        path: value.slice(separator + 1),
      });
    }
    index += 1;
  } else if (arg === '--check') {
    check = true;
  } else if (!arg.startsWith('--')) {
    resultsPath = arg;
  }
}

if (!resultsPath) {
  resultsPath = 'event-log-race-repro-results.json';
}

const historyMarkerStart = '<!-- event-log-race-repro-history';
const historyMarkerEnd = 'event-log-race-repro-history -->';

// How many runs the history table keeps. The table is one row per lane per run,
// so this is the dial that keeps a long-lived PR's comment readable: 5 runs is
// the trend, and the rest is in the artifacts of the older jobs.
const maxHistoryRuns = 5;
// Non-completed runs listed per lane, regressions first.
const maxFailingRows = 10;
// A soak can produce four figures of `infra` rows, all carrying the same one or
// two error codes. The verdict line already reports the count, so the table only
// keeps enough of them to name the code.
const maxInfraRows = 3;

const orderedOutcomes = [
  'completed',
  'CORRUPTED_EVENT_LOG',
  'USER_ERROR',
  'RUNTIME_ERROR',
  'stuck',
  'other',
  // Harness-side, non-gating outcomes (hook-resume vs. sleep-budget timing
  // races and transport errors in the repro driver). Reported but never fail
  // the job — see `gatingOutcomes` / `regressionCount`.
  'infra',
];

// Outcomes that represent a real SDK regression and therefore gate the job.
// Everything that is not `completed` and not `infra`.
const gatingOutcomes = orderedOutcomes.filter(
  (outcome) => outcome !== 'completed' && outcome !== 'infra'
);

// The history table's columns. Deliberately five: the question it answers is
// "did this run trip the storms", and every outcome that is not corruption or a
// stuck run is rare enough that a shared bucket is honest. `infra` sits in
// `Other` so the four count columns always sum to `Total`; the verdict lines
// above the table break out whatever is actually non-zero, including infra.
const summaryColumns = [
  { header: 'Complete', outcomes: ['completed'] },
  { header: 'Corrupt', outcomes: ['CORRUPTED_EVENT_LOG'] },
  { header: 'Stuck', outcomes: ['stuck'] },
  {
    header: 'Other',
    outcomes: ['USER_ERROR', 'RUNTIME_ERROR', 'other', 'infra'],
  },
];

// Short names for the verdict lines, so `6 corrupt, 1 stuck` reads at a glance.
const outcomeShortNames = {
  CORRUPTED_EVENT_LOG: 'corrupt',
  USER_ERROR: 'user error',
  RUNTIME_ERROR: 'runtime error',
  stuck: 'stuck',
  other: 'other',
};

function emptyDistribution() {
  return Object.fromEntries(orderedOutcomes.map((outcome) => [outcome, 0]));
}

function laneNameFromLabel(value) {
  return value.replace(/^world-/, '') || 'vercel';
}

function loadResults(path = resultsPath) {
  if (!path || !fs.existsSync(path)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function loadPreviousComment() {
  if (!previousCommentPath || !fs.existsSync(previousCommentPath)) {
    return '';
  }
  return fs.readFileSync(previousCommentPath, 'utf8');
}

// History is stored as `{ runs: [{ timestamp, runAttempt, runUrl, lanes }] }`.
// Comments written before the lanes shared one comment stored a bare array of
// single-lane entries; those are read as this comment's own lane, which is what
// they were.
function loadHistory(previousComment, fallbackLaneName) {
  if (!previousComment) {
    return [];
  }

  const historyPattern = new RegExp(
    `${historyMarkerStart}\\n([\\s\\S]*?)\\n${historyMarkerEnd}`
  );
  const match = previousComment.match(historyPattern);
  if (!match) {
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return [];
  }

  if (Array.isArray(parsed)) {
    return parsed.map((entry) => ({
      timestamp: entry.timestamp,
      runAttempt: entry.runAttempt,
      runUrl: entry.runUrl,
      lanes: { [fallbackLaneName]: entry },
    }));
  }

  return Array.isArray(parsed?.runs) ? parsed.runs : [];
}

function summarize(results) {
  const distribution = emptyDistribution();
  for (const result of results) {
    distribution[result.outcome] = (distribution[result.outcome] ?? 0) + 1;
  }
  return distribution;
}

// Count of regression-class outcomes — the number the job gates on.
function regressionCount(distribution) {
  return gatingOutcomes.reduce(
    (sum, outcome) => sum + (distribution[outcome] ?? 0),
    0
  );
}

function infraCount(distribution) {
  return distribution.infra ?? 0;
}

function countColumn(distribution = {}, column) {
  return column.outcomes.reduce(
    (sum, outcome) => sum + (distribution[outcome] ?? 0),
    0
  );
}

function compactTimestamp(value) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  // `08-14 17:08` — the year and the seconds never distinguish two rows of the
  // same PR, and the column is narrow enough to sit next to five numbers.
  return new Date(parsed).toISOString().replace('T', ' ').slice(5, 16);
}

function markdownLink(text, href) {
  return href ? `[${text}](${href})` : text;
}

function renderRunCell(run) {
  const attemptSuffix =
    run.runAttempt && Number(run.runAttempt) > 1 ? ` #${run.runAttempt}` : '';
  return `${markdownLink(compactTimestamp(run.timestamp), run.runUrl)}${attemptSuffix}`;
}

// The lane cell doubles as the deployment link, which is the only per-lane URL
// worth a click. Local worlds report `http://localhost:3000`, which is not one.
function renderLaneCell(laneName, entry) {
  const deploymentUrl = entry?.deploymentUrl ?? '';
  const linkable =
    /^https?:\/\//.test(deploymentUrl) && !deploymentUrl.includes('localhost');
  return linkable ? markdownLink(laneName, deploymentUrl) : laneName;
}

function renderOutcomeBreakdown(entry) {
  const distribution = entry.distribution ?? {};
  const parts = gatingOutcomes
    .filter((outcome) => (distribution[outcome] ?? 0) > 0)
    .map(
      (outcome) =>
        `${distribution[outcome]} ${outcomeShortNames[outcome] ?? outcome}`
    );
  const infra = entry.infraCount ?? infraCount(distribution);
  if (infra > 0) {
    parts.push(`${infra} infra`);
  }
  return parts.join(', ');
}

// One line per lane: verdict, then the counts behind it. A partial run's rates
// are still meaningful but its totals are not comparable to a full run's, so
// the line says so rather than letting a short run read as a clean one.
function renderLaneVerdict(laneName, entry, multiLane) {
  // The heading already names the lane when there is only one of them.
  const prefix = multiLane ? `\`${laneName}\` ` : '';
  if (entry.missingResults) {
    // Only that the file is absent is known here. The lane may have died before
    // the harness ran at all (a failed build, or Postgres never coming up), and
    // naming a cause the renderer cannot see sends the reader to the wrong
    // place — its job log is where the reason actually is.
    return `${prefix}no results — the lane wrote no result file, see its job log`;
  }

  const verdict =
    entry.failedCount === 0
      ? `clean, ${entry.total} run${entry.total === 1 ? '' : 's'}`
      : `**${entry.failedCount}/${entry.total} regressions**`;
  const breakdown = renderOutcomeBreakdown(entry);
  const partial = entry.partial
    ? `partial: ${entry.total} of ${entry.plannedAttempts || 'the'} planned runs${
        entry.budgetExhausted ? ', launch budget spent' : ', job ended first'
      }`
    : '';
  return [`${prefix}${verdict}`, breakdown, partial]
    .filter(Boolean)
    .join(' — ');
}

function renderConfigScale(config) {
  const scenarios = [
    config.stepStormAttempts ? `step-storm ${config.stepStormAttempts}` : '',
    config.hookStormAttempts ? `hook-storm ${config.hookStormAttempts}` : '',
    config.hookSleepAttempts ? `hook-sleep ${config.hookSleepAttempts}` : '',
    // Historical entries from the pre-storm harness, kept so an old sticky
    // comment still renders its own configuration rather than a blank line.
    config.stepFanoutAttempts ? `fanout ${config.stepFanoutAttempts}` : '',
    config.stepSleepRaceAttempts ? `race ${config.stepSleepRaceAttempts}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const shape =
    config.rounds && config.width
      ? `${config.rounds}x${config.width}`
      : config.stepFanoutRounds && config.stepFanoutWidth
        ? `${config.stepFanoutRounds}x${config.stepFanoutWidth}`
        : '';
  return [
    config.attempts ? `${config.attempts} runs` : '',
    scenarios,
    config.concurrency ? `c${config.concurrency}` : '',
    shape,
  ].filter(Boolean);
}

function renderConfigTiming(config) {
  return [
    config.watchdogMs ? `watchdog ${config.watchdogMs}ms` : '',
    config.stepDelayMs
      ? `step ${config.stepDelayMs}±${config.stepDelayJitterMs ?? 0}ms`
      : '',
    config.hookResumeStaggerMs ? `stagger ${config.hookResumeStaggerMs}ms` : '',
    config.pokeIntervalMs ? `poke ${config.pokeIntervalMs}ms` : '',
    // The budget belongs next to the cadence it bounds: it is SPENT on the
    // local lanes (every step-storm run there reaches it), so a config line
    // showing only the cadence would read as a run-long stream of out-of-band
    // writes at that rate, which is not what the later rounds received.
    config.pokeMax
      ? `poke budget ${config.pokeMax}${
          config.pokeDecayFactor ? ` then /${config.pokeDecayFactor}` : ''
        }`
      : '',
    config.runTimeoutMs ? `timeout ${config.runTimeoutMs}ms` : '',
  ].filter(Boolean);
}

function renderConfig(entry) {
  const config = entry.config ?? {};
  return [...renderConfigScale(config), ...renderConfigTiming(config)].join(
    ' / '
  );
}

function compactConfig(config = {}) {
  return {
    attempts: config.attempts,
    stepStormAttempts: config.stepStormAttempts,
    hookStormAttempts: config.hookStormAttempts,
    hookSleepAttempts: config.hookSleepAttempts,
    concurrency: config.concurrency,
    rounds: config.rounds,
    width: config.width,
    watchdogMs: config.watchdogMs,
    stepDelayMs: config.stepDelayMs,
    stepDelayJitterMs: config.stepDelayJitterMs,
    reconcileBase: config.reconcileBase,
    attrWrites: config.attrWrites,
    pokeIntervalMs: config.pokeIntervalMs,
    pokeMax: config.pokeMax,
    pokeDecayFactor: config.pokeDecayFactor,
    hookResumeStaggerMs: config.hookResumeStaggerMs,
    runTimeoutMs: config.runTimeoutMs,
    // Pre-storm harness keys, retained so history rows recorded by an older
    // revision of this script keep rendering their own configuration.
    stepFanoutAttempts: config.stepFanoutAttempts,
    stepSleepRaceAttempts: config.stepSleepRaceAttempts,
    stepFanoutRounds: config.stepFanoutRounds,
    stepFanoutWidth: config.stepFanoutWidth,
  };
}

// Only the latest run keeps its per-run detail (`config`, `failing`): nothing
// renders an older run's failures or configuration, and the stored JSON counts
// against the comment's own size limit.
function compactHistoryEntry(entry, keepDetail = false) {
  return {
    deploymentUrl: entry.deploymentUrl,
    missingResults: entry.missingResults,
    partial: entry.partial ?? false,
    budgetExhausted: entry.budgetExhausted ?? false,
    plannedAttempts: entry.plannedAttempts ?? 0,
    distribution: entry.distribution ?? emptyDistribution(),
    failedCount: entry.failedCount ?? 0,
    infraCount: entry.infraCount ?? infraCount(entry.distribution ?? {}),
    total: entry.total ?? 0,
    config: keepDetail ? compactConfig(entry.config) : undefined,
    failing: keepDetail ? (entry.failing ?? []) : [],
    truncatedFailingCount: keepDetail ? (entry.truncatedFailingCount ?? 0) : 0,
  };
}

function compactHistoryRun(run, keepDetail = false) {
  return {
    timestamp: run.timestamp,
    runAttempt: run.runAttempt,
    runUrl: run.runUrl,
    lanes: Object.fromEntries(
      Object.entries(run.lanes ?? {}).map(([laneName, entry]) => [
        laneName,
        compactHistoryEntry(entry, keepDetail),
      ])
    ),
  };
}

function buildEntry(resultsFile) {
  if (!resultsFile) {
    return {
      deploymentUrl: '',
      missingResults: true,
      partial: false,
      budgetExhausted: false,
      plannedAttempts: 0,
      distribution: emptyDistribution(),
      failedCount: 1,
      infraCount: 0,
      total: 0,
      config: {},
      failing: [],
      truncatedFailingCount: 0,
    };
  }

  const results = resultsFile.results ?? [];
  const distribution = resultsFile.distribution ?? summarize(results);
  const failedCount = regressionCount(distribution);
  const infra = infraCount(distribution);
  const total = orderedOutcomes.reduce(
    (sum, outcome) => sum + (distribution[outcome] ?? 0),
    0
  );
  // Regressions first and capped separately from `infra`, so a flood of
  // harness-timing rows can never crowd a real failure out of the table.
  const nonCompleted = results.filter(
    (result) => result.outcome !== 'completed'
  );
  const listed = [
    ...nonCompleted
      .filter((result) => result.outcome !== 'infra')
      .slice(0, maxFailingRows),
    ...nonCompleted
      .filter((result) => result.outcome === 'infra')
      .slice(0, maxInfraRows),
  ];
  const failing = listed.map((result) => ({
    attempt: result.attempt,
    scenario: result.scenario,
    outcome: result.outcome,
    errorCode: result.errorCode,
    runId: result.runId,
    dashboardUrl: result.dashboardUrl,
  }));

  return {
    deploymentUrl: resultsFile.deploymentUrl,
    missingResults: false,
    // The harness checkpoints the file as it goes and only stamps
    // `partial: false` on its final write, so a job killed by cancellation or
    // its own `timeout-minutes` still reports whatever landed.
    partial: resultsFile.partial ?? false,
    budgetExhausted: resultsFile.budgetExhausted ?? false,
    plannedAttempts: resultsFile.plannedAttempts ?? 0,
    distribution,
    failedCount,
    infraCount: infra,
    total,
    config: compactConfig(resultsFile.config),
    failing,
    truncatedFailingCount: Math.max(0, nonCompleted.length - listed.length),
  };
}

function buildRun(lanes) {
  return {
    timestamp,
    runAttempt,
    runUrl,
    lanes: Object.fromEntries(
      lanes.map((lane) => [lane.name, buildEntry(loadResults(lane.path))])
    ),
  };
}

function appendHistory(history, run) {
  const key = `${run.runUrl || run.timestamp}#${run.runAttempt}`;
  const nextHistory = history
    .filter(
      (historyRun) =>
        `${historyRun.runUrl || historyRun.timestamp}#${historyRun.runAttempt}` !==
        key
    )
    .map((historyRun) => compactHistoryRun(historyRun));
  nextHistory.push(compactHistoryRun(run, true));
  return nextHistory.slice(-maxHistoryRuns);
}

// Lanes in the order they were passed on the command line, plus any lane that
// only exists in the stored history (a lane that was removed, or a comment
// written before this lane was added) so its rows keep rendering.
function laneOrder(history, lanes) {
  const names = lanes.map((lane) => lane.name);
  for (const run of history) {
    for (const laneName of Object.keys(run.lanes ?? {})) {
      if (!names.includes(laneName)) {
        names.push(laneName);
      }
    }
  }
  return names;
}

function renderHistoryTable(history, laneNames) {
  const multiLane = laneNames.length > 1;
  const headers = [
    'Run',
    ...(multiLane ? ['Lane'] : []),
    'Total',
    ...summaryColumns.map((column) => column.header),
  ];
  // Counts right-align, the Run and Lane labels do not.
  const alignments = headers.map((_, index) =>
    index === 0 || (multiLane && index === 1) ? ':--' : '--:'
  );

  console.log('### Run History\n');
  console.log(`| ${headers.join(' | ')} |`);
  console.log(`|${alignments.join('|')}|`);

  for (const run of history) {
    let runCell = renderRunCell(run);
    for (const laneName of laneNames) {
      const entry = run.lanes?.[laneName];
      if (!entry) {
        continue;
      }
      const counts = entry.missingResults
        ? ['–', ...summaryColumns.map(() => '–')]
        : [
            String(entry.total),
            ...summaryColumns.map((column) =>
              String(countColumn(entry.distribution, column))
            ),
          ];
      const cells = [
        runCell,
        ...(multiLane ? [renderLaneCell(laneName, entry)] : []),
        ...counts,
      ];
      console.log(`| ${cells.join(' | ')} |`);
      // One run spans several lane rows; only the first of them is stamped, so
      // the run reads as one block.
      runCell = '';
    }
  }
  console.log('');
}

function renderFailingRow(laneName, result, multiLane) {
  const runLink =
    result.dashboardUrl && result.runId
      ? markdownLink(result.runId, result.dashboardUrl)
      : (result.runId ?? '');
  // `outcome` and `errorCode` are the same string for the corruption-class
  // outcomes; the code is only worth naming when it says something the outcome
  // does not (`infra` / `HOOK_RESUME_FAILED`).
  const outcome =
    result.errorCode && result.errorCode !== result.outcome
      ? `${result.outcome} (${result.errorCode})`
      : result.outcome;
  const cells = [
    ...(multiLane ? [laneName] : []),
    result.scenario ?? '',
    result.attempt,
    outcome,
    runLink,
  ];
  return `| ${cells.join(' | ')} |`;
}

function renderLatestFailures(run, laneNames) {
  const multiLane = laneNames.length > 1;
  const lanes = laneNames
    .map((laneName) => ({ laneName, entry: run.lanes?.[laneName] }))
    .filter(({ entry }) => entry && !entry.missingResults);
  const rows = lanes.flatMap(({ laneName, entry }) =>
    (entry.failing ?? []).map((result) => ({ laneName, result }))
  );
  const truncated = lanes.reduce(
    (sum, { entry }) => sum + (entry.truncatedFailingCount ?? 0),
    0
  );

  if (rows.length === 0) {
    return;
  }

  const headers = [
    ...(multiLane ? ['Lane'] : []),
    'Scenario',
    'Attempt',
    'Outcome',
    'Run',
  ];
  console.log('### Latest Non-Completed Runs\n');
  console.log(`| ${headers.join(' | ')} |`);
  console.log(`|${multiLane ? ':--|' : ''}:--|--:|:--|:--|`);
  for (const { laneName, result } of rows) {
    console.log(renderFailingRow(laneName, result, multiLane));
  }
  if (truncated > 0) {
    console.log(
      `\n${rows.length} of ${rows.length + truncated} non-completed runs shown.`
    );
  }
  console.log('');
}

// Scale is identical across lanes on a normal run (one set of
// `EVENT_LOG_RACE_REPRO_*` inputs feeds every job), so identical configurations
// collapse to one line and only a dispatch that somehow differs prints two.
function renderConfigDetails(run, laneNames, collapsible) {
  const byConfig = new Map();
  for (const laneName of laneNames) {
    const entry = run.lanes?.[laneName];
    if (!entry || entry.missingResults) {
      continue;
    }
    const rendered = renderConfig(entry);
    if (!rendered) {
      continue;
    }
    byConfig.set(rendered, [...(byConfig.get(rendered) ?? []), laneName]);
  }

  if (byConfig.size === 0) {
    return;
  }

  // Collapsed in the comment, plain text in a terminal.
  console.log(
    collapsible ? '<details><summary>Config</summary>\n' : 'Config\n'
  );
  for (const [rendered, lanes] of byConfig) {
    const prefix = byConfig.size > 1 ? `\`${lanes.join('`, `')}\`: ` : '';
    console.log(`${prefix}${rendered}\n`);
  }
  if (collapsible) {
    console.log('</details>\n');
  }
}

function render(lanes, previousComment) {
  const fallbackLaneName = laneNameFromLabel(label);
  const history = appendHistory(
    loadHistory(previousComment, fallbackLaneName),
    buildRun(lanes)
  );
  const latest = history[history.length - 1];
  const laneNames = laneOrder(history, lanes);
  const latestLaneNames = laneNames.filter((name) => latest.lanes?.[name]);

  // The sticky-comment marker and the stored history are for the PR comment
  // only. A local run has no `--run-url`, and there they would be two blocks of
  // JSON and HTML in a terminal.
  const forComment = Boolean(runUrl);
  if (forComment) {
    console.log(
      `<!-- event-log-race-repro-results${label ? `-${label}` : ''} -->`
    );
  }
  console.log(`## Event Log Race Repro${label ? ` (${label})` : ''}\n`);
  const multiLane = latestLaneNames.length > 1;
  for (const laneName of latestLaneNames) {
    console.log(
      `- ${renderLaneVerdict(laneName, latest.lanes[laneName], multiLane)}`
    );
  }
  console.log('');
  if (forComment) {
    console.log(historyMarkerStart);
    console.log(JSON.stringify({ runs: history }));
    console.log(historyMarkerEnd);
    console.log('');
  }

  renderHistoryTable(history, laneNames);
  renderLatestFailures(latest, latestLaneNames);
  renderConfigDetails(latest, latestLaneNames, forComment);
}

function main() {
  const lanes = laneArgs.length
    ? laneArgs
    : [{ name: laneNameFromLabel(label), path: resultsPath }];

  if (!check) {
    render(lanes, loadPreviousComment());
    process.exit(0);
  }

  // `--check` is the gate, and it only ever looks at one lane's file: the lane
  // that gates (Vercel) runs it in its own job, on its own results.
  const resultsFile = loadResults();
  if (!resultsFile) {
    process.exit(1);
  }
  const distribution =
    resultsFile.distribution ?? summarize(resultsFile.results ?? []);
  process.exit(regressionCount(distribution) > 0 ? 1 : 0);
}

// Pure helpers are exported for unit testing; the CLI only runs when the
// script is executed directly (not when required by the test).
module.exports = {
  orderedOutcomes,
  gatingOutcomes,
  summaryColumns,
  summarize,
  regressionCount,
  infraCount,
  countColumn,
  buildEntry,
  maxFailingRows,
  maxHistoryRuns,
};

if (require.main === module) {
  main();
}
