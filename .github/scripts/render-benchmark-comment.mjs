#!/usr/bin/env node
/**
 * Renders the sticky PR comment for the Performance Benchmarks workflow.
 *
 * The comment shows the latest benchmark results prominently and keeps the
 * results of previous runs on the same PR in a collapsed <details> section.
 * History survives re-renders because the full data set is embedded in the
 * comment itself as a base64-encoded JSON block inside an HTML comment
 * (`<!-- benchmark-data:... -->`), which this script reads back from the
 * previous comment body on the next run.
 *
 * Usage:
 *   node render-benchmark-comment.mjs \
 *     --status running|completed|failed \
 *     [--results-dir <dir>]        # dir with bench-results-*.json files
 *     [--baseline-dir <dir>]       # main-branch results to diff averages against
 *     [--previous-body <file>]     # previous comment body to carry history from
 *     [--commit <sha>] [--run-url <url>] \
 *     [--output <file>]            # defaults to stdout
 */

import fs from 'node:fs';
import path from 'node:path';

const DATA_MARKER = 'benchmark-data:';
const MAX_HISTORY_ENTRIES = 10;
// GitHub caps comment bodies at 65536 chars; leave headroom.
const MAX_COMMENT_CHARS = 60_000;

const METRIC_LABELS = {
  ttfs: { name: 'TTFS', description: 'time to first step body execution' },
  stso: {
    name: 'STSO',
    description: 'step-to-step overhead (gap between consecutive step bodies)',
  },
  wo: {
    name: 'WO',
    description:
      'workflow overhead (time outside step bodies, client start → last step body exit)',
  },
  sl: {
    name: 'SL',
    description: 'stream latency (first chunk write → visible to the reader)',
  },
};
const METRIC_ORDER = ['ttfs', 'stso', 'wo', 'sl'];

export function parseArgs(argv) {
  const args = {
    status: 'completed',
    resultsDir: undefined,
    baselineDir: undefined,
    previousBody: undefined,
    commit: undefined,
    runUrl: undefined,
    output: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const next = () => {
      i++;
      if (i >= argv.length) throw new Error(`Missing value for ${argv[i - 1]}`);
      return argv[i];
    };
    switch (argv[i]) {
      case '--status':
        args.status = next();
        break;
      case '--results-dir':
        args.resultsDir = next();
        break;
      case '--baseline-dir':
        args.baselineDir = next();
        break;
      case '--previous-body':
        args.previousBody = next();
        break;
      case '--commit':
        args.commit = next();
        break;
      case '--run-url':
        args.runUrl = next();
        break;
      case '--output':
        args.output = next();
        break;
      default:
        throw new Error(`Unknown argument: ${argv[i]}`);
    }
  }
  if (!['running', 'completed', 'failed'].includes(args.status)) {
    throw new Error(`Invalid --status: ${args.status}`);
  }
  return args;
}

/** Extracts embedded history from a previous comment body. */
export function extractHistory(body) {
  if (!body) return [];
  const match = body.match(/<!--\s*benchmark-data:([A-Za-z0-9+/=]+)\s*-->/);
  if (!match) return [];
  try {
    const data = JSON.parse(Buffer.from(match[1], 'base64').toString('utf8'));
    if (data?.version === 1 && Array.isArray(data.entries)) {
      return data.entries;
    }
  } catch {
    // Malformed/legacy data block — start fresh.
  }
  return [];
}

export function encodeHistory(entries) {
  const json = JSON.stringify({ version: 1, entries });
  return `<!-- ${DATA_MARKER}${Buffer.from(json, 'utf8').toString('base64')} -->`;
}

function loadResultFile(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed?.version === 1 && Array.isArray(parsed.metrics)) {
      return parsed;
    }
    console.error(`Skipping ${file}: unexpected format`);
  } catch (error) {
    console.error(`Skipping ${file}: ${error.message}`);
  }
  return undefined;
}

/** Loads all bench-results-*.json files from a directory (recursively). */
export function loadResults(resultsDir) {
  if (!resultsDir || !fs.existsSync(resultsDir)) return [];
  const results = [];
  const walk = (dir) => {
    for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        walk(full);
      } else if (/^bench-results-.*\.json$/.test(dirent.name)) {
        const parsed = loadResultFile(full);
        if (parsed) results.push(parsed);
      }
    }
  };
  walk(resultsDir);
  results.sort((a, b) =>
    `${a.backend}/${a.app}`.localeCompare(`${b.backend}/${b.app}`)
  );
  return results;
}

function formatMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  return `${Math.abs(value) >= 100 ? Math.round(value) : value}`;
}

/**
 * Annotates each metric row with the matching baseline average (from the most
 * recent main-branch run), keyed by backend/app/metric/scenario. The
 * annotation is stored on the entry so history re-renders keep showing the
 * delta each run was originally compared against.
 */
export function annotateWithBaseline(results, baseline) {
  if (!baseline || baseline.length === 0) return results;
  const baselineAvgs = new Map();
  for (const result of baseline) {
    for (const row of result.metrics ?? []) {
      baselineAvgs.set(
        `${result.backend}/${result.app}/${row.metric}/${row.scenario}`,
        row.avg
      );
    }
  }
  return results.map((result) => ({
    ...result,
    metrics: (result.metrics ?? []).map((row) => {
      const baselineAvg = baselineAvgs.get(
        `${result.backend}/${result.app}/${row.metric}/${row.scenario}`
      );
      return typeof baselineAvg === 'number' ? { ...row, baselineAvg } : row;
    }),
  }));
}

/** Formats the avg-vs-main delta, e.g. " (+4.2%)"; empty without a baseline. */
function formatDelta(current, baselineAvg) {
  if (
    typeof current !== 'number' ||
    typeof baselineAvg !== 'number' ||
    baselineAvg <= 0 ||
    !Number.isFinite(current / baselineAvg)
  ) {
    return '';
  }
  const pct = ((current - baselineAvg) / baselineAvg) * 100;
  if (Math.abs(pct) < 0.5) return ' (±0%)';
  const digits = Math.abs(pct) >= 10 ? 0 : 1;
  return ` (${pct > 0 ? '+' : ''}${pct.toFixed(digits)}%)`;
}

/**
 * Formats a percentile cell, marking it 🟢/🔴 against its target when one is
 * defined for this row.
 */
function formatCell(value, target) {
  const formatted = formatMs(value);
  if (formatted === '—' || typeof target !== 'number') return formatted;
  return `${formatted} ${value <= target ? '🟢' : '🔴'}`;
}

function shortCommit(commit) {
  return commit ? commit.slice(0, 7) : 'unknown';
}

function metricSortKey(row) {
  const idx = METRIC_ORDER.indexOf(row.metric);
  return idx === -1 ? METRIC_ORDER.length : idx;
}

function renderResultTable(result) {
  const lines = [
    '| Metric | Scenario | Avg (ms) | P75 (ms) | P90 (ms) | P99 (ms) | Samples |',
    '|--------|----------|---------:|---------:|---------:|---------:|--------:|',
  ];
  const rows = [...result.metrics].sort(
    (a, b) => metricSortKey(a) - metricSortKey(b)
  );
  for (const row of rows) {
    const label = METRIC_LABELS[row.metric];
    // Abbreviations only — the definitions live in the comment footer.
    const name = label ? `**${label.name}**` : row.metric;
    const targets = row.targets ?? {};
    lines.push(
      `| ${name} | ${row.scenario} | ${formatMs(row.avg)}${formatDelta(row.avg, row.baselineAvg)} | ${formatCell(row.p75, targets.p75)} | ${formatCell(row.p90, targets.p90)} | ${formatCell(row.p99, targets.p99)} | ${row.samples} |`
    );
  }
  return lines.join('\n');
}

function renderEntry(entry, { heading }) {
  const lines = [];
  const meta = [
    // The heading already names the commit for collapsed history entries.
    heading ? undefined : `commit \`${shortCommit(entry.commit)}\``,
    entry.generatedAt ? new Date(entry.generatedAt).toUTCString() : undefined,
    entry.runUrl ? `[run logs](${entry.runUrl})` : undefined,
  ]
    .filter(Boolean)
    .join(' · ');
  if (heading) lines.push(heading);
  lines.push(meta, '');
  for (const result of entry.results) {
    if (entry.results.length > 1 || heading) {
      lines.push(`**\`${result.backend}\` / \`${result.app}\`**`, '');
    } else {
      lines.push(`Backend: \`${result.backend}\` · app: \`${result.app}\``, '');
    }
    lines.push(renderResultTable(result), '');
  }
  return lines.join('\n');
}

/** Scenario legend, emitted by the benchmark runner alongside the metrics. */
function buildScenarioLegend(results) {
  const scenarios = new Map();
  for (const result of results) {
    for (const { name, description } of result.scenarios ?? []) {
      if (!scenarios.has(name)) scenarios.set(name, description);
    }
  }
  return [...scenarios]
    .map(([name, description]) => `**${name}**: ${description}`)
    .join(' · ');
}

/** Targets legend, derived from the per-row targets in the results. */
function buildTargetsLegend(results) {
  const targets = new Map();
  for (const result of results) {
    for (const row of result.metrics ?? []) {
      if (!row.targets) continue;
      const label = METRIC_LABELS[row.metric]?.name ?? row.metric;
      const range = row.scenario.match(/\(\d+-\d+\)$/)?.[0];
      const key = range ? `${label} ${range}` : label;
      targets.set(
        key,
        `${key} ${row.targets.p75 ?? '—'}/${row.targets.p90 ?? '—'}/${row.targets.p99 ?? '—'}`
      );
    }
  }
  return [...targets.values()].join(' · ');
}

function renderFooter(entries) {
  const results = entries.flatMap((entry) => entry.results ?? []);
  const definitions = METRIC_ORDER.map(
    (id) => `**${METRIC_LABELS[id].name}**: ${METRIC_LABELS[id].description}`
  ).join(' · ');
  const scenarioLegend = buildScenarioLegend(results);
  const targetsLegend = buildTargetsLegend(results);
  const hasBaseline = results.some((result) =>
    (result.metrics ?? []).some((row) => typeof row.baselineAvg === 'number')
  );

  return [
    ...(hasBaseline
      ? [
          '<sub>Avg deltas compare against the most recent benchmark run on `main` at the time of this run.</sub>',
          '',
        ]
      : []),
    `<sub>Metrics — ${definitions}</sub>`,
    ...(scenarioLegend ? ['', `<sub>Scenarios — ${scenarioLegend}</sub>`] : []),
    ...(targetsLegend
      ? [
          '',
          `<sub>🟢/🔴 mark percentiles within/above target. Targets (p75/p90/p99, ms) — ${targetsLegend}</sub>`,
        ]
      : []),
    '',
    '<sub>TTFS/WO compare client vs deployment clocks and SL compares the step runner’s clock vs the client’s (NTP-synced in CI). WO ends at the last step body exit, the closest observable proxy for the final step-completion request.</sub>',
  ].join('\n');
}

function renderBanner({ status, commit, runUrl, entries, results }) {
  const lines = [];
  if (status === 'running') {
    lines.push(
      `⏳ **Benchmarks are running for ${commit ? `\`${shortCommit(commit)}\`` : 'the latest commit'}...**${runUrl ? ` ([run logs](${runUrl}))` : ''}`,
      ''
    );
    if (entries.length > 0) {
      lines.push('> Results below are from a previous run.', '');
    }
  } else if (status === 'failed') {
    lines.push(
      `❌ **The benchmark run${commit ? ` for \`${shortCommit(commit)}\`` : ''} failed.**${runUrl ? ` See the [run logs](${runUrl}) for details.` : ''}`,
      ''
    );
    if (results.length > 0) {
      lines.push('Partial results from the failed run:', '');
    }
  }
  return lines;
}

function renderLatest(latest, status) {
  if (latest) {
    return [renderEntry(latest, { heading: undefined })];
  }
  return status !== 'running'
    ? ['_No benchmark results were produced._', '']
    : [];
}

function renderHistorySection(shownPrevious) {
  if (shownPrevious.length === 0) return [];
  return [
    '<details>',
    `<summary>📜 Previous results (${shownPrevious.length})</summary>`,
    '',
    ...shownPrevious.map((entry) =>
      renderEntry(entry, { heading: `#### ${shortCommit(entry.commit)}` })
    ),
    '</details>',
    '',
  ];
}

export function renderComment({
  status,
  results,
  baseline = [],
  history,
  commit,
  runUrl,
  now = new Date(),
}) {
  let entries = [...history];
  if (status !== 'running' && results.length > 0) {
    entries = [
      {
        commit,
        runUrl,
        generatedAt: now.toISOString(),
        results: annotateWithBaseline(results, baseline),
      },
      ...entries,
    ].slice(0, MAX_HISTORY_ENTRIES);
  }

  const render = (historyCount) =>
    [
      '<!-- benchmark-results -->',
      '## 📊 Workflow Benchmarks',
      '',
      ...renderBanner({ status, commit, runUrl, entries, results }),
      ...renderLatest(entries[0], status),
      ...renderHistorySection(entries.slice(1, 1 + historyCount)),
      renderFooter(entries.slice(0, 1)),
      '',
      encodeHistory(entries),
    ].join('\n');

  // Shrink the visible history (never the embedded data) until the comment
  // fits GitHub's size limit.
  for (let count = entries.length; count >= 0; count--) {
    const body = render(count);
    if (body.length <= MAX_COMMENT_CHARS) return body;
  }
  // Last resort: drop embedded history entries too.
  while (entries.length > 1) {
    entries = entries.slice(0, entries.length - 1);
    const body = render(0);
    if (body.length <= MAX_COMMENT_CHARS) return body;
  }
  return render(0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const previousBody = args.previousBody
    ? fs.existsSync(args.previousBody)
      ? fs.readFileSync(args.previousBody, 'utf8')
      : ''
    : '';
  const history = extractHistory(previousBody);
  const results = loadResults(args.resultsDir);
  const baseline = loadResults(args.baselineDir);
  if (args.baselineDir && baseline.length === 0) {
    console.error(`No baseline results found in ${args.baselineDir}`);
  }

  if (args.status === 'completed' && results.length === 0) {
    console.error('No benchmark results found for status=completed');
    process.exitCode = 1;
  }

  const body = renderComment({
    status: args.status,
    results,
    baseline,
    history,
    commit: args.commit,
    runUrl: args.runUrl,
  });

  if (args.output) {
    fs.writeFileSync(args.output, body);
    console.error(`Comment written to ${args.output} (${body.length} chars)`);
  } else {
    process.stdout.write(body);
  }
}

// Only run main() when executed directly (not when imported by tests).
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === new URL(import.meta.url).pathname
) {
  main();
}
