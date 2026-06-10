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

// Human-readable, one-line explanations keyed by outcome (for gating
// regressions) and by errorCode (for non-gating `infra` noise). Rendered next
// to the counts so a human reading the PR comment knows what each row means
// without spelunking the test source.
const OUTCOME_NOTES = {
  CORRUPTED_EVENT_LOG:
    'Event log failed an integrity/ordering check — a real durability regression.',
  USER_ERROR: 'Workflow surfaced a user-visible error during the run.',
  RUNTIME_ERROR: 'Runtime/platform error thrown while executing the run.',
  stuck:
    'Run never reached a terminal state before the timeout — possible wedged event log. Open the linked run and check its latest event.',
  other: 'Uncategorised non-completion — inspect the linked run.',
};

const INFRA_CODE_NOTES = {
  HOOK_RESUME_FAILED:
    'Resume lost the race: the run already completed (sleep budget elapsed) before the harness delivered the hook resume. Expected under load.',
  NO_WAKE_BRANCH:
    'Sleep branch won the race, so the hook-wake path was not exercised this run. Coverage loss, not corruption.',
  SLOW_COMPLETION:
    'Run completed, but only after the poll budget (within the grace window) — slow under load, not wedged. Not an SDK failure.',
  CANCELLED:
    'Run was cancelled (superseded or aborted) rather than completing — not an SDK failure.',
  HARNESS_ERROR:
    'Repro driver/transport error (e.g. `fetch failed`) talking to the deployment — not an SDK failure.',
};

const MAX_MESSAGE_LENGTH = 160;
// Gating regressions are always listed in full (normally a handful); this cap
// is only a runaway guard. Infra noise can number in the thousands, so we keep
// counts for every code but only a few example links per code.
const REGRESSION_ROW_CAP = 200;
const INFRA_EXAMPLES_PER_CODE = 3;

function truncateMessage(message) {
  if (!message) {
    return '';
  }
  const oneLine = String(message).replace(/\s+/g, ' ').trim();
  return oneLine.length > MAX_MESSAGE_LENGTH
    ? `${oneLine.slice(0, MAX_MESSAGE_LENGTH - 1)}…`
    : oneLine;
}

// A stuck run carries no errorMessage, so synthesise one from its duration.
function describeFailure(result) {
  const explicit = truncateMessage(result.errorMessage);
  if (explicit) {
    return explicit;
  }
  if (result.outcome === 'stuck' && result.durationMs) {
    return `no terminal state after ${result.durationMs}ms`;
  }
  return '';
}

function projectFailure(result) {
  return {
    attempt: result.attempt,
    scenario: result.scenario,
    outcome: result.outcome,
    status: result.status,
    errorCode: result.errorCode,
    message: describeFailure(result),
    durationMs: result.durationMs,
    runId: result.runId,
    dashboardUrl: result.dashboardUrl,
  };
}

// Count non-completions by a stable key (errorCode, falling back to the
// outcome) and retain a few example runs per key for inspection links.
function breakdownByCode(results) {
  const counts = {};
  const examples = {};
  for (const result of results) {
    const key = result.errorCode || `(${result.outcome})`;
    counts[key] = (counts[key] ?? 0) + 1;
    examples[key] ??= [];
    if (examples[key].length < INFRA_EXAMPLES_PER_CODE) {
      examples[key].push({
        runId: result.runId,
        dashboardUrl: result.dashboardUrl,
        message: describeFailure(result),
      });
    }
  }
  return { counts, examples };
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
    // Per-code counts are tiny, so keep them on every history entry. The full
    // regression list and example links are only kept for the latest entry.
    regressionBreakdown: entry.regressionBreakdown ?? {
      counts: {},
      examples: {},
    },
    infraBreakdown: entry.infraBreakdown ?? { counts: {}, examples: {} },
    regressions: keepFailures ? (entry.regressions ?? []) : [],
    truncatedRegressionCount: keepFailures
      ? (entry.truncatedRegressionCount ?? 0)
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
      regressions: [],
      truncatedRegressionCount: 0,
      regressionBreakdown: { counts: {}, examples: {} },
      infraBreakdown: { counts: {}, examples: {} },
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
  // Gating regressions (stuck / corruption / errors) are what a human must
  // act on, so list every one of them in full. Infra noise can be thousands of
  // rows, so we keep per-code counts plus a few example links instead.
  const regressionResults = results.filter(
    (result) => result.outcome !== 'completed' && result.outcome !== 'infra'
  );
  const infraResults = results.filter((result) => result.outcome === 'infra');

  const regressions = regressionResults
    .slice(0, REGRESSION_ROW_CAP)
    .map(projectFailure);
  const truncatedRegressionCount = Math.max(
    0,
    regressionResults.length - regressions.length
  );
  const regressionBreakdown = breakdownByCode(regressionResults);
  const infraBreakdown = breakdownByCode(infraResults);

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
    regressions,
    truncatedRegressionCount,
    regressionBreakdown,
    infraBreakdown,
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

function runLink(result) {
  if (result.dashboardUrl && result.runId) {
    return `[${result.runId}](${result.dashboardUrl})`;
  }
  return result.runId ?? '';
}

// Every gating regression, listed in full with its message, duration and a
// direct dashboard link — this is the table a human acts on.
function renderRegressions(entry) {
  if (entry.missingResults) {
    return;
  }

  const regressions = entry.regressions ?? [];
  if (regressions.length === 0) {
    console.log('### Event-Log Regressions\n');
    console.log('None — no gating outcomes in the latest run. ✅\n');
    return;
  }

  console.log(`### 🚨 Event-Log Regressions (${entry.failedCount})\n`);
  console.log(
    'These gate the job. Each row links to the workflow run on the dashboard.\n'
  );
  console.log(
    '| Scenario | Attempt | Outcome | Status | Duration | Detail | Run |'
  );
  console.log('|:--|--:|:--|:--|--:|:--|:--|');
  for (const result of regressions) {
    const duration =
      typeof result.durationMs === 'number' ? `${result.durationMs}ms` : '';
    const detail =
      result.message || OUTCOME_NOTES[result.outcome] || result.errorCode || '';
    console.log(
      `| ${result.scenario ?? ''} | ${result.attempt} | ${result.outcome} | ${result.status ?? ''} | ${duration} | ${detail} | ${runLink(result)} |`
    );
  }
  if (entry.truncatedRegressionCount > 0) {
    console.log(
      `\nShowing ${regressions.length} of ${regressions.length + entry.truncatedRegressionCount} regressions (capped). See the run logs artifact for the full list.`
    );
  }
  console.log('');
}

// Non-gating harness noise, grouped by error code with a plain-language note
// and a couple of example runs so a human can confirm the classification.
function renderInfraBreakdown(entry) {
  if (entry.missingResults) {
    return;
  }

  const breakdown = entry.infraBreakdown ?? { counts: {}, examples: {} };
  const codes = Object.keys(breakdown.counts ?? {});
  if (codes.length === 0) {
    return;
  }

  codes.sort((a, b) => breakdown.counts[b] - breakdown.counts[a]);

  console.log('### Infra (non-gating)\n');
  console.log(
    `${entry.infraCount} harness-side non-completion${entry.infraCount === 1 ? ' that does' : 's that do'} **not** fail the job:\n`
  );
  console.log('| Error code | Count | What it means | Examples |');
  console.log('|:--|--:|:--|:--|');
  for (const code of codes) {
    const note = INFRA_CODE_NOTES[code] ?? 'Harness-side non-completion.';
    const examples = (breakdown.examples?.[code] ?? [])
      .map((example) => runLink(example))
      .filter(Boolean)
      .join('<br>');
    console.log(
      `| ${code} | ${breakdown.counts[code]} | ${note} | ${examples} |`
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

  // Compact "904 HOOK_RESUME_FAILED, 61 NO_WAKE_BRANCH" style summary of the
  // infra noise so the headline says *why* the non-completions happened.
  const infraCounts = latest.infraBreakdown?.counts ?? {};
  const infraDigest = Object.keys(infraCounts)
    .sort((a, b) => infraCounts[b] - infraCounts[a])
    .map((code) => `${infraCounts[code]} ${code}`)
    .join(', ');
  const infraNote =
    latestInfra > 0
      ? ` ${latestInfra} non-gating infra non-completion${latestInfra === 1 ? '' : 's'}` +
        `${infraDigest ? ` (${infraDigest})` : ''} ${latestInfra === 1 ? 'is reported but does' : 'are reported but do'} not fail the job.`
      : '';

  console.log('<!-- event-log-race-repro-results -->');
  console.log('## Event Log Race Repro\n');
  console.log(
    latest.missingResults
      ? 'No result file was produced by the latest repro job.'
      : latest.failedCount === 0
        ? `✅ No event-log regressions in the latest repro job.${infraNote}`
        : `🚨 ${latest.failedCount} of ${latest.total} latest repro runs hit event-log regressions — see the linked runs below.${infraNote}`
  );
  console.log('');
  console.log(historyMarkerStart);
  console.log(JSON.stringify(history));
  console.log(historyMarkerEnd);
  console.log('');

  renderRegressions(latest);
  renderInfraBreakdown(latest);
  renderHistoryTable(history);
  renderLatestScenarioBreakdown(latest);
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
  breakdownByCode,
  truncateMessage,
  describeFailure,
};

if (require.main === module) {
  main();
}
