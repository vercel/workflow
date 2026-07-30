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
 *     [--results-dir <dir>]        # dir with run 2's bench-results-*.json files
 *     [--baseline-dir <dir>]       # run 1's results (same commit) to diff against
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
  ttfs: {
    name: 'TTFS',
    description:
      'time to first step body (in-deployment start() → first step body, deployment clocks)',
  },
  stso: {
    name: 'STSO',
    description: 'step-to-step overhead (gap between consecutive step bodies)',
  },
  wo: {
    name: 'WO',
    description:
      'workflow overhead (whole-run time outside step bodies, in-deployment anchored)',
  },
  sl: {
    name: 'SL',
    description:
      'stream latency (in-deployment write → read propagation, readAt - writtenAt)',
  },
  so: {
    name: 'SO',
    description:
      'stream overhead (end-to-end write+consume time beyond the modelled generation window)',
  },
};
const METRIC_ORDER = ['ttfs', 'stso', 'wo', 'sl', 'so'];

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
 * Annotates each metric row with the matching baseline values (best, p75, p90,
 * p99) from the paired baseline run — run 1 of the same commit, run
 * back-to-back with the "current" run (run 2) in the same job — keyed by
 * methodologyVersion/backend/app/metric/scenario. The methodology version is
 * part of the key so a change to the measurement window (e.g. the switch to
 * the in-deployment trigger) does not diff incomparable numbers. The
 * annotations are stored on the entry so history re-renders keep showing the
 * deltas each run was originally compared against.
 */
// Which run field each baseline annotation is compared against, and where the
// baseline value is read from (best falls back to a pre-rename baseline's min).
const BASELINE_FIELDS = [
  { annotation: 'baselineBest', from: (base) => base.best ?? base.min },
  { annotation: 'baselineP75', from: (base) => base.p75 },
  { annotation: 'baselineP90', from: (base) => base.p90 },
  { annotation: 'baselineP99', from: (base) => base.p99 },
];

export function annotateWithBaseline(results, baseline) {
  if (!baseline || baseline.length === 0) return results;
  const methodology = (result) => result.methodologyVersion ?? 'legacy';
  const keyFor = (result, row) =>
    `${methodology(result)}/${result.backend}/${result.app}/${row.metric}/${row.scenario}`;
  const resultKeyFor = (result) =>
    `${methodology(result)}/${result.backend}/${result.app}`;
  const baselineRows = new Map();
  const baselineResults = new Map();
  for (const result of baseline) {
    baselineResults.set(resultKeyFor(result), result);
    for (const row of result.metrics ?? []) {
      baselineRows.set(keyFor(result, row), row);
    }
  }
  const annotate = (result, row) => {
    const base = baselineRows.get(keyFor(result, row));
    if (!base) return row;
    const annotated = { ...row };
    for (const { annotation, from } of BASELINE_FIELDS) {
      const value = from(base);
      if (typeof value === 'number') annotated[annotation] = value;
    }
    // Raw samples (when the run recorded them) enable the histogram/cumulative
    // diff below the table — kept separate from BASELINE_FIELDS since it's an
    // array, not a numeric percentile.
    if (Array.isArray(base.raw)) annotated.baselineRaw = base.raw;
    return annotated;
  };
  return results.map((result) => {
    const baseResult = baselineResults.get(resultKeyFor(result));
    return {
      ...result,
      metrics: (result.metrics ?? []).map((row) => annotate(result, row)),
      ...(Array.isArray(baseResult?.sequentialRuns)
        ? { baselineSequentialRuns: baseResult.sequentialRuns }
        : {}),
    };
  });
}

const sum = (values) => values.reduce((total, v) => total + v, 0);

/** Buckets samples into fixed-width ms bins; anything past `binWidth *
 * maxBins` is folded into a single overflow bucket, so a handful of outliers
 * don't blow up the table width. */
function buildHistogram(samples, binWidth, maxBins) {
  const counts = new Array(maxBins).fill(0);
  let overflow = 0;
  for (const v of samples) {
    const idx = Math.floor(v / binWidth);
    if (idx >= 0 && idx < maxBins) counts[idx]++;
    else overflow++;
  }
  return { counts, overflow };
}

// Target bin count for the STSO histogram diff — the actual bin *width* is
// derived per-row from the observed sample range (see chooseBinWidth), since
// a fixed width picked for one scenario's typical latency (e.g. sub-100ms)
// silently dumps every sample into a single overflow bucket for another
// (e.g. a colder run at 200-500ms/step).
const STSO_HISTOGRAM_TARGET_BINS = 12;

/** Rounds a raw bin width up to a "nice" 1/2/5 * 10^n step, so bucket
 * boundaries read cleanly (e.g. 20ms, 50ms) instead of arbitrary fractions. */
function chooseBinWidth(maxValue, targetBins) {
  if (!Number.isFinite(maxValue) || maxValue <= 0) return 1;
  const raw = maxValue / targetBins;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const niceNormalized =
    normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return niceNormalized * magnitude;
}

function formatDeltaValue(delta, unit = '') {
  return `${delta >= 0 ? '+' : ''}${Math.round(delta)}${unit}`;
}

/** Non-empty (bucket label, run 1 count, run 2 count) triples for a
 * histogram, including the overflow bucket (labeled `${max}+`) when either
 * run has samples there. Shared by the bar chart and the table so both
 * render from the exact same bucketing. */
function nonEmptyBuckets(current, baseline, binWidth, binCount) {
  const buckets = [];
  for (let i = 0; i < binCount; i++) {
    if (current.counts[i] === 0 && baseline.counts[i] === 0) continue;
    buckets.push({
      label: `${i * binWidth}-${(i + 1) * binWidth}`,
      base: baseline.counts[i],
      cur: current.counts[i],
    });
  }
  if (current.overflow > 0 || baseline.overflow > 0) {
    buckets.push({
      label: `${binCount * binWidth}+`,
      base: baseline.overflow,
      cur: current.overflow,
    });
  }
  return buckets;
}

// Bar width (characters) for the ASCII histogram overlay.
const BAR_CHART_WIDTH = 24;

/**
 * Renders one bucket as a single overlay bar: a solid `█` run for run 1's
 * count, a `┃` notch marking exactly where run 2's count lands, and — only
 * when run 2 exceeds run 1 — a lighter `░` run bridging the gap between them
 * so the extension past the base bar is visually distinct from the base
 * itself. One glance shows both run 1's magnitude (bar length/shade) and run
 * 2's relative position (the notch) without needing two separate bars.
 */
function renderOverlayBar(base, cur, maxCount) {
  if (maxCount <= 0) return '';
  const scale = (count) =>
    count <= 0
      ? 0
      : Math.max(1, Math.round((count / maxCount) * BAR_CHART_WIDTH));
  const baseWidth = scale(base);
  const notchPos = scale(cur);
  if (notchPos <= baseWidth) {
    // Notch sits inside (or right at the end of) the solid base bar.
    const notchIndex = Math.max(0, notchPos - 1);
    return (
      '█'.repeat(notchIndex) +
      '┃' +
      '█'.repeat(Math.max(0, baseWidth - notchIndex - 1))
    );
  }
  // Run 2 exceeds run 1: extend past the base in a lighter shade, capped by
  // the notch marking run 2's exact value.
  return `${'█'.repeat(baseWidth)}${'░'.repeat(notchPos - baseWidth - 1)}┃`;
}

/** Renders run 1 vs run 2 as one overlay bar per bucket (a fenced code
 * block keeps bars aligned in a monospace font), so the shape of the two
 * distributions — and exactly how far run 2 diverged from run 1 — is
 * visible at a glance instead of only as numbers in a table. */
function renderStsoBarChart(buckets) {
  const maxCount = Math.max(1, ...buckets.map((b) => Math.max(b.base, b.cur)));
  const labelWidth = Math.max(...buckets.map((b) => b.label.length));
  const lines = ['```'];
  for (const { label, base, cur } of buckets) {
    const bar = renderOverlayBar(base, cur, maxCount).padEnd(BAR_CHART_WIDTH);
    lines.push(
      `${label.padStart(labelWidth)} ms  ${bar}  R1 ${base}  R2 ${cur}`
    );
  }
  lines.push('```');
  return lines.join('\n');
}

// TEMPORARY (websockets-vs-HTTP A/B test): "inline" steps (same warm process
// as the step before them) cluster tightly — the adaptive bin width was
// hiding a bimodal split between them (e.g. a fast ~150-250ms mode vs a
// slower ~300-400ms+ mode) behind ~500ms-wide bins. Hardcode a finer 50ms
// width for just this scenario so that split is visible; queue-hop steps
// (dispatch + cold reinit, much larger and sparser) keep the adaptive width.
const STSO_INLINE_BIN_WIDTH_MS = 50;

/** Renders one STSO row's cumulative-time line, an ASCII bar-chart overlay,
 * and a bucketed histogram table (run 2 vs run 1). Bin width is chosen from
 * this row's own sample range, so every scenario gets a histogram that
 * actually spreads across multiple buckets rather than overflowing into
 * one — except "inline" rows, which use a hardcoded finer width (see
 * STSO_INLINE_BIN_WIDTH_MS). */
function renderStsoRowDiff(row) {
  const maxValue = Math.max(...row.raw, ...row.baselineRaw);
  const binWidth = row.scenario.includes('(inline)')
    ? STSO_INLINE_BIN_WIDTH_MS
    : chooseBinWidth(maxValue, STSO_HISTOGRAM_TARGET_BINS);
  // +1 bin of headroom so the max sample lands inside the range rather than
  // exactly on (and thus overflowing) the last edge.
  const binCount = Math.ceil(maxValue / binWidth) + 1;

  const current = buildHistogram(row.raw, binWidth, binCount);
  const baseline = buildHistogram(row.baselineRaw, binWidth, binCount);
  const currentTotal = sum(row.raw);
  const baselineTotal = sum(row.baselineRaw);
  const totalDelta = currentTotal - baselineTotal;
  const totalPct =
    baselineTotal > 0 ? (totalDelta / baselineTotal) * 100 : undefined;
  const pctSuffix =
    totalPct === undefined ? '' : `, ${formatDeltaValue(totalPct)}%`;

  const buckets = nonEmptyBuckets(current, baseline, binWidth, binCount);

  const lines = [
    '',
    `_${row.scenario}_`,
    '',
    `Cumulative STSO time: run 1 ${Math.round(baselineTotal)}ms → run 2 ${Math.round(currentTotal)}ms (Δ ${formatDeltaValue(totalDelta, 'ms')}${pctSuffix})`,
    '',
  ];
  if (buckets.length > 0) {
    lines.push(renderStsoBarChart(buckets), '');
  }
  lines.push(
    '| Bucket (ms) | Run 1 steps | Run 2 steps | Δ |',
    '|---|---:|---:|---:|'
  );
  for (const { label, base, cur } of buckets) {
    lines.push(
      `| ${label} | ${base} | ${cur} | ${formatDeltaValue(cur - base)} |`
    );
  }
  return lines.join('\n');
}

/**
 * Renders a Datadog trace link per sequential-steps iteration (run 1 and run
 * 2), when the deployment's `/api/bench` route reported a trace id. Lets
 * anyone reading the comment jump straight to the trace for either run
 * without hunting for it by deployment id / time window.
 */
function renderSequentialTracesSection(result) {
  const runs2 = result.sequentialRuns ?? [];
  const runs1 = result.baselineSequentialRuns ?? [];
  if (runs2.length === 0 && runs1.length === 0) return '';

  const traceLink = (run) =>
    run?.traceId
      ? `[trace](https://app.datadoghq.com/apm/trace/${run.traceId})`
      : undefined;

  const lines = ['', '**Sequential-steps run traces**', ''];
  const count = Math.max(runs1.length, runs2.length);
  for (let i = 0; i < count; i++) {
    const r1 = runs1[i];
    const r2 = runs2[i];
    const r1Text = r1
      ? `\`${r1.runId}\`${traceLink(r1) ? ` — ${traceLink(r1)}` : ' (no trace id)'}`
      : '—';
    const r2Text = r2
      ? `\`${r2.runId}\`${traceLink(r2) ? ` — ${traceLink(r2)}` : ' (no trace id)'}`
      : '—';
    lines.push(`- Run 1: ${r1Text} · Run 2: ${r2Text}`);
  }
  return lines.join('\n');
}

/**
 * Renders a per-scenario histogram diff (bucketed step counts, run 2 vs run
 * 1) and a cumulative-time diff (sum of all STSO samples, run 2 vs run 1) for
 * every STSO row that has raw samples from both runs. This is a
 * complement to the Best/P75/P90/P99 table: percentiles hide *how many*
 * steps moved and by how much in aggregate, which is what these two views
 * are for.
 */
function renderStsoDiffSection(result) {
  const rows = (result.metrics ?? []).filter(
    (row) =>
      row.metric === 'stso' &&
      Array.isArray(row.raw) &&
      Array.isArray(row.baselineRaw)
  );
  if (rows.length === 0) return '';

  const lines = [
    '',
    '**STSO histogram & cumulative time diff (run 2 vs run 1)**',
  ];
  for (const row of rows) {
    lines.push(renderStsoRowDiff(row));
  }
  return lines.join('\n');
}

// Deltas beyond ±this vs the paired baseline run get a directional marker: 🔻 for a regression,
// 💚 for an improvement. Smaller moves show the percentage alone.
const DELTA_MARK_THRESHOLD_PCT = 15;

/**
 * Formats a delta vs the paired baseline run, e.g. " (+4.2%)"; empty without a
 * baseline. Moves worse than +15% are flagged 🔻 and moves better than -15%
 * are flagged 💚.
 */
function formatDelta(current, baseline) {
  if (
    typeof current !== 'number' ||
    typeof baseline !== 'number' ||
    baseline <= 0 ||
    !Number.isFinite(current / baseline)
  ) {
    return '';
  }
  const pct = ((current - baseline) / baseline) * 100;
  const mark =
    pct > DELTA_MARK_THRESHOLD_PCT
      ? ' 🔻'
      : pct < -DELTA_MARK_THRESHOLD_PCT
        ? ' 💚'
        : '';
  if (Math.abs(pct) < 0.5) return ' (±0%)';
  const digits = Math.abs(pct) >= 10 ? 0 : 1;
  return ` (${pct > 0 ? '+' : ''}${pct.toFixed(digits)}%)${mark}`;
}

/**
 * Formats a percentile cell, marking it 🔴 when it is over its target. Within
 * target is left unmarked (no 🟢) to keep the table quiet — only misses stand
 * out.
 */
function formatCell(value, target) {
  const formatted = formatMs(value);
  if (formatted === '—' || typeof target !== 'number') return formatted;
  return value > target ? `${formatted} 🔴` : formatted;
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
    '| Metric | Scenario | Best (ms) | P75 (ms) | P90 (ms) | P99 (ms) | Samples |',
    '|--------|----------|----------:|---------:|---------:|---------:|--------:|',
  ];
  const rows = [...result.metrics].sort(
    (a, b) => metricSortKey(a) - metricSortKey(b)
  );
  for (const row of rows) {
    const label = METRIC_LABELS[row.metric];
    // Abbreviations only — the definitions live in the comment footer.
    const name = label ? `**${label.name}**` : row.metric;
    const targets = row.targets ?? {};
    // Deltas vs the paired baseline run are shown on Best/P75/P90/P99.
    lines.push(
      `| ${name} | ${row.scenario} | ${formatMs(row.best)}${formatDelta(row.best, row.baselineBest)} | ${formatCell(row.p75, targets.p75)}${formatDelta(row.p75, row.baselineP75)} | ${formatCell(row.p90, targets.p90)}${formatDelta(row.p90, row.baselineP90)} | ${formatCell(row.p99, targets.p99)}${formatDelta(row.p99, row.baselineP99)} | ${row.samples} |`
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
    const tracesSection = renderSequentialTracesSection(result);
    if (tracesSection) lines.push(tracesSection, '');
    const stsoDiff = renderStsoDiffSection(result);
    if (stsoDiff) lines.push(stsoDiff, '');
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
    (result.metrics ?? []).some(
      (row) =>
        typeof row.baselineBest === 'number' ||
        typeof row.baselineP75 === 'number' ||
        typeof row.baselineP90 === 'number' ||
        typeof row.baselineP99 === 'number'
    )
  );

  const smallprint = [
    ...(hasBaseline
      ? [
          '<sub>Best/P75/P90/P99 deltas compare two back-to-back runs of this same commit against the same deployment, so they reflect run-to-run benchmark noise rather than a change vs `main`. 🔻 flags a delta worse than +15%, 💚 one better than −15%.</sub>',
          '',
        ]
      : []),
    `<sub>Metrics — ${definitions}</sub>`,
    ...(scenarioLegend ? ['', `<sub>Scenarios — ${scenarioLegend}</sub>`] : []),
    ...(targetsLegend
      ? [
          '',
          `<sub>🔴 marks a percentile over its target (within target is left unmarked). Targets (p75/p90/p99, ms) — ${targetsLegend}</sub>`,
        ]
      : []),
    '',
    '<sub>All metrics are measured from deployment-side timestamps only. Runs are triggered by an in-deployment route that stamps the anchor (`clientStart`) right before `start()`, so the CI runner’s request and its path through api.vercel.com sit outside every measured window. TTFS = in-deployment `start()` → first step body (turbo uses the in-process fast path, non-turbo the dispatch path), and includes the VQS dispatch hop plus any `/flow` cold start. STSO/WO are measured between step bodies on the deployment. SL is measured inside the workflow (parallel reader/writer steps), so it no longer includes the api.vercel.com read path.</sub>',
    '',
    '<sub>Cold starts are kept in the numbers on purpose — they are part of real bursty-workload latency. The workbench deployment cold-starts the `/flow` invocation for a large fraction of runs, inflating P75+; the **Best** column shows the fastest (warm-start) sample for comparison.</sub>',
  ];

  // Keep the definitions/methodology out of the way in a collapsed dropdown,
  // mirroring the "Previous results" section. The blank line after <summary>
  // lets GitHub render the markdown inside the <details> block.
  return [
    '<details>',
    '<summary>ℹ️ Metric definitions & methodology</summary>',
    '',
    smallprint.join('\n'),
    '</details>',
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
