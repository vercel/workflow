#!/usr/bin/env node

const fs = require('node:fs');

const args = process.argv.slice(2);
let resultsPath = 'event-log-race-repro-results.json';
let runUrl = '';
let previousCommentPath = '';
let timestamp = new Date().toISOString();
let runAttempt = '';
let check = false;

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
  } else if (arg === '--check') {
    check = true;
  } else if (!arg.startsWith('--')) {
    resultsPath = arg;
  }
}

const historyMarkerStart = '<!-- event-log-race-repro-history';
const historyMarkerEnd = 'event-log-race-repro-history -->';

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

function emptyDistribution() {
  return Object.fromEntries(orderedOutcomes.map((outcome) => [outcome, 0]));
}

function loadResults() {
  if (!fs.existsSync(resultsPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
}

function loadPreviousComment() {
  if (!previousCommentPath || !fs.existsSync(previousCommentPath)) {
    return '';
  }
  return fs.readFileSync(previousCommentPath, 'utf8');
}

function loadHistory(previousComment) {
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

  try {
    const history = JSON.parse(match[1]);
    return Array.isArray(history) ? history : [];
  } catch {
    return [];
  }
}

function summarize(results) {
  const distribution = emptyDistribution();
  for (const result of results) {
    distribution[result.outcome] = (distribution[result.outcome] ?? 0) + 1;
  }
  return distribution;
}

function summarizeByScenario(results) {
  const byScenario = {};
  for (const result of results) {
    const scenario = result.scenario ?? 'unknown';
    byScenario[scenario] ??= emptyDistribution();
    byScenario[scenario][result.outcome] =
      (byScenario[scenario][result.outcome] ?? 0) + 1;
  }
  return byScenario;
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

function compactTimestamp(value) {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  return `${new Date(parsed).toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

function markdownLink(label, href) {
  return href ? `[${label}](${href})` : label;
}

function renderRunHeader(entry) {
  const links = [
    entry.runUrl ? markdownLink('logs', entry.runUrl) : '',
    entry.deploymentUrl ? markdownLink('deploy', entry.deploymentUrl) : '',
  ].filter(Boolean);
  const attemptSuffix = entry.runAttempt ? ` #${entry.runAttempt}` : '';
  return `${compactTimestamp(entry.timestamp)}${attemptSuffix}<br>${links.join(' / ')}`;
}

function renderCount(value) {
  return String(value ?? 0);
}

function renderResult(entry) {
  if (entry.missingResults) {
    return 'missing result file';
  }
  const infra = entry.infraCount ?? infraCount(entry.distribution ?? {});
  const infraSuffix = infra > 0 ? ` (+${infra} infra)` : '';
  return entry.failedCount === 0
    ? `no regressions${infraSuffix}`
    : `${entry.failedCount}/${entry.total} regressions${infraSuffix}`;
}

function renderConfig(entry) {
  const config = entry.config ?? {};
  const attempts = config.attempts ? `${config.attempts} runs` : '';
  const scenarios = [
    config.hookSleepAttempts ? `hook ${config.hookSleepAttempts}` : '',
    config.stepFanoutAttempts ? `fanout ${config.stepFanoutAttempts}` : '',
    config.stepSleepRaceAttempts ? `race ${config.stepSleepRaceAttempts}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  const concurrency = config.concurrency ? `c${config.concurrency}` : '';
  const stepConcurrency = config.stepConcurrency
    ? `step c${config.stepConcurrency}`
    : '';
  const iterations = config.iterations ? `${config.iterations} iters` : '';
  return [attempts, scenarios, concurrency, stepConcurrency, iterations]
    .filter(Boolean)
    .join(' / ');
}

function renderTiming(entry) {
  const config = entry.config ?? {};
  return [
    config.sleepMs ? `sleep ${config.sleepMs}ms` : '',
    config.resumeDelayMs || config.resumeJitterMs
      ? `resume ${config.resumeDelayMs ?? 0}+${config.resumeJitterMs ?? 0}ms`
      : '',
    config.runTimeoutMs ? `timeout ${config.runTimeoutMs}ms` : '',
  ]
    .filter(Boolean)
    .join(' / ');
}

function compactConfig(config = {}) {
  return {
    attempts: config.attempts,
    hookSleepAttempts: config.hookSleepAttempts,
    stepFanoutAttempts: config.stepFanoutAttempts,
    stepSleepRaceAttempts: config.stepSleepRaceAttempts,
    concurrency: config.concurrency,
    stepConcurrency: config.stepConcurrency,
    iterations: config.iterations,
    sleepMs: config.sleepMs,
    resumeDelayMs: config.resumeDelayMs,
    resumeJitterMs: config.resumeJitterMs,
    runTimeoutMs: config.runTimeoutMs,
    stepFanoutRounds: config.stepFanoutRounds,
    stepFanoutWidth: config.stepFanoutWidth,
    stepRaceRounds: config.stepRaceRounds,
  };
}

function compactHistoryEntry(entry, keepFailures = false) {
  return {
    timestamp: entry.timestamp,
    runAttempt: entry.runAttempt,
    runUrl: entry.runUrl,
    deploymentUrl: entry.deploymentUrl,
    missingResults: entry.missingResults,
    distribution: entry.distribution ?? emptyDistribution(),
    scenarioDistribution: entry.scenarioDistribution ?? {},
    failedCount: entry.failedCount ?? 0,
    infraCount: entry.infraCount ?? infraCount(entry.distribution ?? {}),
    total: entry.total ?? 0,
    config: compactConfig(entry.config),
    failing: keepFailures ? (entry.failing ?? []) : [],
    truncatedFailingCount: keepFailures
      ? (entry.truncatedFailingCount ?? 0)
      : 0,
  };
}

function buildEntry(resultsFile) {
  if (!resultsFile) {
    return {
      timestamp,
      runAttempt,
      runUrl,
      deploymentUrl: '',
      missingResults: true,
      distribution: emptyDistribution(),
      failedCount: 1,
      total: 0,
      config: {},
      scenarioDistribution: {},
      failing: [],
    };
  }

  const results = resultsFile.results ?? [];
  const distribution = resultsFile.distribution ?? summarize(results);
  const scenarioDistribution =
    resultsFile.scenarioDistribution ?? summarizeByScenario(results);
  const failedCount = regressionCount(distribution);
  const infra = infraCount(distribution);
  const total = orderedOutcomes.reduce(
    (sum, outcome) => sum + (distribution[outcome] ?? 0),
    0
  );
  // Surface regressions before infra so the 20-row cap never hides a real
  // failure behind a flood of harness-timing `infra` rows.
  const nonCompleted = results
    .filter((result) => result.outcome !== 'completed')
    .sort(
      (a, b) => Number(a.outcome === 'infra') - Number(b.outcome === 'infra')
    );
  const failing = nonCompleted.slice(0, 20).map((result) => ({
    attempt: result.attempt,
    scenario: result.scenario,
    outcome: result.outcome,
    status: result.status,
    errorCode: result.errorCode,
    runId: result.runId,
    dashboardUrl: result.dashboardUrl,
  }));

  return {
    timestamp,
    runAttempt,
    runUrl,
    deploymentUrl: resultsFile.deploymentUrl,
    missingResults: false,
    distribution,
    scenarioDistribution,
    failedCount,
    infraCount: infra,
    total,
    config: compactConfig(resultsFile.config),
    failing,
    truncatedFailingCount: Math.max(0, nonCompleted.length - failing.length),
  };
}

function appendHistory(history, entry) {
  const key = `${entry.runUrl || entry.timestamp}#${entry.runAttempt}`;
  const nextHistory = history
    .filter(
      (historyEntry) =>
        `${historyEntry.runUrl || historyEntry.timestamp}#${historyEntry.runAttempt}` !==
        key
    )
    .map((historyEntry) => compactHistoryEntry(historyEntry));
  nextHistory.push(compactHistoryEntry(entry, true));
  return nextHistory;
}

function renderHistoryTable(history) {
  console.log('### Run History\n');
  console.log(`| Metric | ${history.map(renderRunHeader).join(' | ')} |`);
  console.log(`|:--|${history.map(() => ':--').join('|')}|`);
  console.log(`| Result | ${history.map(renderResult).join(' | ')} |`);
  console.log(`| Total | ${history.map((entry) => entry.total).join(' | ')} |`);
  for (const outcome of orderedOutcomes) {
    console.log(
      `| ${outcome} | ${history
        .map((entry) => renderCount(entry.distribution?.[outcome]))
        .join(' | ')} |`
    );
  }
  console.log(`| Config | ${history.map(renderConfig).join(' | ')} |`);
  console.log(`| Timing | ${history.map(renderTiming).join(' | ')} |`);
  console.log('');
}

function renderLatestScenarioBreakdown(entry) {
  if (entry.missingResults) {
    return;
  }

  const scenarioEntries = Object.entries(entry.scenarioDistribution ?? {});
  if (scenarioEntries.length === 0) {
    return;
  }

  console.log('### Latest Scenario Breakdown\n');
  console.log(`| Scenario | Total | ${orderedOutcomes.join(' | ')} |`);
  console.log(`|:--|--:|${orderedOutcomes.map(() => '--:').join('|')}|`);
  for (const [scenario, distribution] of scenarioEntries) {
    const total = orderedOutcomes.reduce(
      (sum, outcome) => sum + (distribution[outcome] ?? 0),
      0
    );
    console.log(
      `| ${scenario} | ${total} | ${orderedOutcomes
        .map((outcome) => renderCount(distribution[outcome]))
        .join(' | ')} |`
    );
  }
  console.log('');
}

function renderLatestFailures(entry) {
  if (entry.missingResults) {
    return;
  }

  if (entry.failing.length === 0) {
    return;
  }

  console.log('### Latest Non-Completed Runs\n');
  console.log('| Scenario | Attempt | Outcome | Status | Error code | Run |');
  console.log('|:--|--:|:--|:--|:--|:--|');
  for (const result of entry.failing) {
    const run =
      result.dashboardUrl && result.runId
        ? `[${result.runId}](${result.dashboardUrl})`
        : (result.runId ?? '');
    console.log(
      `| ${result.scenario ?? ''} | ${result.attempt} | ${result.outcome} | ${result.status ?? ''} | ${result.errorCode ?? ''} | ${run} |`
    );
  }
  if (entry.truncatedFailingCount > 0) {
    console.log(
      `\nShowing 20 of ${entry.failing.length + entry.truncatedFailingCount} non-completed runs.`
    );
  }
  console.log('');
}

function render(resultsFile, previousComment) {
  const history = appendHistory(
    loadHistory(previousComment),
    buildEntry(resultsFile)
  );
  const latest = history[history.length - 1];

  const latestInfra =
    latest.infraCount ?? infraCount(latest.distribution ?? {});
  const infraNote =
    latestInfra > 0
      ? ` ${latestInfra} run${latestInfra === 1 ? '' : 's'} hit harness-side ` +
        '`infra` outcomes (hook-resume timing races / transport errors); ' +
        'these are reported but do not fail the job.'
      : '';

  console.log('<!-- event-log-race-repro-results -->');
  console.log('## Event Log Race Repro\n');
  console.log(
    latest.missingResults
      ? 'No result file was produced by the latest repro job.'
      : latest.failedCount === 0
        ? `No event-log regressions in the latest repro job.${infraNote}`
        : `${latest.failedCount} of ${latest.total} latest repro runs hit event-log regressions.${infraNote}`
  );
  console.log('');
  console.log(historyMarkerStart);
  console.log(JSON.stringify(history));
  console.log(historyMarkerEnd);
  console.log('');

  renderHistoryTable(history);
  renderLatestScenarioBreakdown(latest);
  renderLatestFailures(latest);
}

function main() {
  const resultsFile = loadResults();
  const previousComment = loadPreviousComment();

  if (!resultsFile) {
    if (!check) {
      render(null, previousComment);
    }
    process.exit(check ? 1 : 0);
  }

  if (!check) {
    render(resultsFile, previousComment);
    process.exit(0);
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
  summarize,
  summarizeByScenario,
  regressionCount,
  infraCount,
  buildEntry,
};

if (require.main === module) {
  main();
}
