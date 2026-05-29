#!/usr/bin/env node

const fs = require('node:fs');

const args = process.argv.slice(2);
let resultsPath = 'event-log-race-repro-results.json';
let runUrl = '';
let check = false;

for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === '--run-url' && args[index + 1]) {
    runUrl = args[index + 1];
    index += 1;
  } else if (arg === '--check') {
    check = true;
  } else if (!arg.startsWith('--')) {
    resultsPath = arg;
  }
}

const orderedOutcomes = [
  'completed',
  'CORRUPTED_EVENT_LOG',
  'USER_ERROR',
  'RUNTIME_ERROR',
  'stuck',
  'other',
];

function emptyDistribution() {
  return Object.fromEntries(orderedOutcomes.map((outcome) => [outcome, 0]));
}

function loadResults() {
  if (!fs.existsSync(resultsPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
}

function summarize(results) {
  const distribution = emptyDistribution();
  for (const result of results) {
    distribution[result.outcome] = (distribution[result.outcome] ?? 0) + 1;
  }
  return distribution;
}

function nonCompletedCount(distribution) {
  return orderedOutcomes
    .filter((outcome) => outcome !== 'completed')
    .reduce((sum, outcome) => sum + (distribution[outcome] ?? 0), 0);
}

function renderMissing() {
  console.log('<!-- event-log-race-repro-results -->');
  console.log('## Event Log Race Repro\n');
  console.log('No result file was produced by the repro job.\n');
  if (runUrl) {
    console.log(`Workflow run: ${runUrl}`);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This is a small markdown renderer for one CI comment.
function render(resultsFile) {
  const results = resultsFile.results ?? [];
  const distribution = resultsFile.distribution ?? summarize(results);
  const failedCount = nonCompletedCount(distribution);
  const total = orderedOutcomes.reduce(
    (sum, outcome) => sum + (distribution[outcome] ?? 0),
    0
  );

  console.log('<!-- event-log-race-repro-results -->');
  console.log('## Event Log Race Repro\n');
  console.log(
    failedCount === 0
      ? 'All repro runs completed.'
      : `${failedCount} of ${total} repro runs did not complete cleanly.`
  );
  console.log('');

  console.log('| Outcome | Count |');
  console.log('|:--|--:|');
  for (const outcome of orderedOutcomes) {
    console.log(`| ${outcome} | ${distribution[outcome] ?? 0} |`);
  }
  console.log('');

  const config = resultsFile.config ?? {};
  console.log('### Configuration\n');
  console.log('| Setting | Value |');
  console.log('|:--|:--|');
  console.log(`| Attempts | ${config.attempts ?? ''} |`);
  console.log(`| Concurrency | ${config.concurrency ?? ''} |`);
  console.log(`| Iterations | ${config.iterations ?? ''} |`);
  console.log(`| Sleep | ${config.sleepMs ?? ''}ms |`);
  console.log(`| Resume delay | ${config.resumeDelayMs ?? ''}ms |`);
  console.log(`| Resume jitter | ${config.resumeJitterMs ?? ''}ms |`);
  console.log(`| Run timeout | ${config.runTimeoutMs ?? ''}ms |`);
  if (resultsFile.deploymentUrl) {
    console.log(`| Deployment | ${resultsFile.deploymentUrl} |`);
  }
  console.log('');

  const failing = results.filter((result) => result.outcome !== 'completed');
  if (failing.length > 0) {
    console.log('### Non-Completed Runs\n');
    console.log('| Attempt | Outcome | Status | Error code | Run |');
    console.log('|--:|:--|:--|:--|:--|');
    for (const result of failing.slice(0, 20)) {
      const run =
        result.dashboardUrl && result.runId
          ? `[${result.runId}](${result.dashboardUrl})`
          : (result.runId ?? '');
      console.log(
        `| ${result.attempt} | ${result.outcome} | ${result.status ?? ''} | ${result.errorCode ?? ''} | ${run} |`
      );
    }
    if (failing.length > 20) {
      console.log(`\nShowing 20 of ${failing.length} non-completed runs.`);
    }
    console.log('');
  }

  if (runUrl) {
    console.log(`Workflow run: ${runUrl}`);
  }
}

const resultsFile = loadResults();

if (!resultsFile) {
  if (!check) {
    renderMissing();
  }
  process.exit(check ? 1 : 0);
}

if (!check) {
  render(resultsFile);
}

const distribution =
  resultsFile.distribution ?? summarize(resultsFile.results ?? []);
process.exit(nonCompletedCount(distribution) > 0 ? 1 : 0);
