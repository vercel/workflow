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
  ttfs: {
    name: 'TTFS',
    description:
      'time to first step body (in-deployment start() → first step body)',
  },
  'fanout-ttfs': {
    name: 'Fan-out TTFS',
    description:
      'fan-out time to first step (in-deployment start() → first of the parallel step bodies to complete)',
  },
  'fanout-ttls': {
    name: 'Fan-out TTLS',
    description:
      'fan-out time to last step (in-deployment start() → last of the parallel step bodies to complete, i.e. when the Promise.all resolves)',
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
  // Name reservations: CTT = future production one-way write→read metric
  // (cross-clock); TTFC = future consumer-journey start → first-chunk-readable
  // metric. The 'first chunk (pooled)' row is neither (readAt₀ - writtenAt₀,
  // a round trip), so it stays under CRTT.
  crtt: {
    name: 'CRTT',
    description:
      'chunk round-trip time (per-chunk write → read latency, one clock domain: deployment → stream backend → same deployment)',
  },
  cdv: {
    name: 'CDV',
    description:
      "chunk delay variation / delivery jitter (inter-arrival gap minus inter-write gap per seq-adjacent pair; skew-free; the row is each run's MAX positive value, so one stall moves it)",
  },
  slip: {
    // Title-case on purpose (a word, not an initialism). Artifact-only.
    name: 'Slip',
    description:
      "write slip (how late each chunk was written vs the writer's open-loop schedule; the row is each run's MAX — the producer-stall guard that RTT and CDV both hide)",
  },
};
const METRIC_ORDER = [
  'ttfs',
  'fanout-ttfs',
  'fanout-ttls',
  'stso',
  'wo',
  'sl',
  'so',
  'crtt',
  'cdv',
  'slip',
];

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

/**
 * Drops the per-metric raw sample arrays (and the CRTT fixed-bin histograms)
 * before embedding an entry in the comment's data block. The sequential-steps
 * scenario records ~1000 STSO samples per run (plus the baseline's), which
 * would blow past GitHub's comment size limit within a couple of history
 * entries; the percentiles and baseline annotations — everything the history
 * tables render — are kept.
 *
 * This does not affect the distribution diffs against `main`: those read
 * their baselines from the artifacts the workflow downloads into
 * --baseline-dir, which keep raw samples and histograms. What it costs is the
 * collapsed "Previous results" entries, re-rendered from this block on a
 * later commit of the same PR — they show their tables but not their
 * histograms.
 */
function stripRawSamples(entries) {
  return entries.map((entry) => ({
    ...entry,
    results: (entry.results ?? []).map((result) => ({
      ...result,
      metrics: (result.metrics ?? []).map(
        ({
          raw,
          baselineRaw,
          hist,
          progressAvgMs,
          sizeAvgMs,
          cdvAvgMs,
          ...row
        }) => {
          // Stream rows: keep the median columns for history tables, drop
          // the per-run arrays.
          if (row.stream?.runs) {
            const { runs, ...medians } = row.stream;
            return { ...row, stream: medians };
          }
          return row;
        }
      ),
    })),
  }));
}

export function encodeHistory(entries) {
  const json = JSON.stringify({
    version: 1,
    entries: stripRawSamples(entries),
  });
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
  // Round to one decimal below 100 (and trim float artifacts like
  // 54.650000000000006 from upstream averaging), integers above.
  return `${Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 10) / 10}`;
}

/**
 * Annotates each metric row with the matching baseline values (best, p75, p90,
 * p99) from the most recent main-branch run, keyed by
 * methodologyVersion/backend/app/metric/scenario. The methodology version is
 * part of the key so a change to the measurement window (e.g. the switch to
 * the in-deployment trigger) does not diff incomparable numbers: an old
 * baseline won't match the new run, and the delta stays blank until `main` has
 * produced a same-methodology baseline. The annotations are stored on the entry
 * so history re-renders keep showing the deltas each run was originally
 * compared against.
 */
// Which run field each baseline annotation is compared against, and where the
// baseline value is read from (best falls back to a pre-rename baseline's min).
const BASELINE_FIELDS = [
  { annotation: 'baselineBest', from: (base) => base.best ?? base.min },
  { annotation: 'baselineP75', from: (base) => base.p75 },
  { annotation: 'baselineP90', from: (base) => base.p90 },
  { annotation: 'baselineP99', from: (base) => base.p99 },
  // Not rendered in the main table (no Avg/P50 columns there), but the CRTT
  // drill-down matrix shows vs-main deltas on both (avg deltas are exact).
  { annotation: 'baselineAvg', from: (base) => base.avg },
  { annotation: 'baselineP50', from: (base) => base.p50 },
];

export function annotateWithBaseline(results, baseline) {
  if (!baseline || baseline.length === 0) return results;
  const methodology = (result) => result.methodologyVersion ?? 'legacy';
  const keyFor = (result, row) =>
    `${methodology(result)}/${result.backend}/${result.app}/${row.metric}/${row.scenario}`;
  const baselineRows = new Map();
  for (const result of baseline) {
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
    // Raw samples (when the baseline run recorded them) drive the STSO
    // histogram diff below the table — kept separate from BASELINE_FIELDS
    // since it's an array, not a numeric percentile.
    if (Array.isArray(base.raw)) annotated.baselineRaw = base.raw;
    // Stream rows diff their rate/CDV columns against the baseline's stream
    // object (per-run arrays dropped — only the medians are compared).
    if (row.stream && base.stream) {
      const { runs, ...medians } = base.stream;
      annotated.baselineStream = medians;
    }
    return annotated;
  };
  return results.map((result) => ({
    ...result,
    metrics: (result.metrics ?? []).map((row) => annotate(result, row)),
  }));
}

// ============================================================================
// STSO distribution diff (histogram + cumulative time, vs main)
// ============================================================================

const sum = (values) => values.reduce((total, v) => total + v, 0);

const maxOf = (values) => values.reduce((m, v) => (v > m ? v : m), 0);

/** Buckets samples into fixed-width ms bins. Anything past `binWidth *
 * maxBins` is folded into a single overflow bucket, so a handful of outliers
 * don't blow up the table width. Negative samples get their own bucket rather
 * than joining that overflow: step timestamps come from two different step
 * bodies, so a gap can come out slightly negative under clock skew, and
 * lumping those in with the slowest samples would invert what the tail
 * bucket means. */
function buildHistogram(samples, binWidth, maxBins) {
  const counts = new Array(maxBins).fill(0);
  let overflow = 0;
  let underflow = 0;
  for (const v of samples) {
    const idx = Math.floor(v / binWidth);
    if (idx >= 0 && idx < maxBins) counts[idx]++;
    else if (idx < 0) underflow++;
    else overflow++;
  }
  return { counts, overflow, underflow };
}

// Target bin count for the STSO histogram diff — the actual bin *width* is
// derived per-row from the observed sample range (see chooseBinWidth), since
// a fixed width picked for one scenario's typical latency (e.g. sub-100ms)
// silently dumps every sample into a single overflow bucket for another
// (e.g. a colder run at 200-500ms/step).
const STSO_HISTOGRAM_TARGET_BINS = 12;

// "Inline" steps (same warm process as the step before them) cluster tightly,
// and the adaptive width above is coarse enough (~500ms bins on a run whose
// samples top out in the seconds) to hide structure inside that cluster —
// e.g. a bimodal split between a fast ~150-250ms mode and a slower ~350ms+
// one. Hardcode a finer width for those rows; queue-hop steps (dispatch +
// cold reinit, much larger and far sparser) keep the adaptive width.
const STSO_INLINE_BIN_WIDTH_MS = 50;

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

/** Non-empty (bucket label, main count, this-run count) triples for a
 * histogram, including the overflow bucket (labeled `${max}+`) when either
 * side has samples there. Shared by the bar chart and the table so both
 * render from the exact same bucketing. */
function nonEmptyBuckets(current, baseline, binWidth, binCount) {
  const buckets = [];
  if (current.underflow > 0 || baseline.underflow > 0) {
    buckets.push({
      label: '<0 (skew)',
      base: baseline.underflow,
      cur: current.underflow,
    });
  }
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
 * Renders one bucket as a single overlay bar: a solid `█` run for the
 * baseline's (main's) count, a `┃` notch marking exactly where this run's
 * count lands, and — only when this run exceeds the baseline — a lighter `░`
 * run bridging the gap between them so the extension past the base bar is
 * visually distinct from the base itself. One glance shows both the
 * baseline's magnitude (bar length) and this run's relative position (the
 * notch) without needing two separate bars.
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
  // This run exceeds the baseline: extend past the base in a lighter shade,
  // capped by the notch marking this run's exact value.
  return `${'█'.repeat(baseWidth)}${'░'.repeat(notchPos - baseWidth - 1)}┃`;
}

/** Renders main vs this run as one overlay bar per bucket, with both counts
 * and their delta on the same line (a fenced code block keeps everything
 * aligned in a monospace font). This is the whole histogram diff — the shape
 * of the two distributions and the per-bucket numbers behind it, without a
 * second table restating them. Shared by the STSO section (buckets = step
 * counts) and the CRTT section (buckets = chunk counts); `selfLabel` names
 * the series when there is no baseline to overlay. */
function renderHistogramBarChart(
  buckets,
  { selfDiff, selfLabel = 'steps' } = {}
) {
  const maxCount = Math.max(1, ...buckets.map((b) => Math.max(b.base, b.cur)));
  const labelWidth = Math.max(...buckets.map((b) => b.label.length));
  const countWidth = Math.max(
    ...buckets.map((b) => String(Math.max(b.base, b.cur)).length)
  );
  const lines = ['```'];
  for (const { label, base, cur } of buckets) {
    // Without a baseline the two counts are the same series; render one solid
    // bar rather than an overlay of a run against itself.
    const bar = (
      selfDiff
        ? '█'.repeat(
            Math.max(1, Math.round((cur / maxCount) * BAR_CHART_WIDTH))
          )
        : renderOverlayBar(base, cur, maxCount)
    ).padEnd(BAR_CHART_WIDTH);
    const counts = selfDiff
      ? `${selfLabel} ${String(cur).padStart(countWidth)}`
      : `main ${String(base).padStart(countWidth)}  this ${String(cur).padStart(countWidth)}  ${formatDeltaValue(cur - base).padStart(countWidth + 1)}`;
    lines.push(`${label.padStart(labelWidth)} ms  ${bar}  ${counts}`);
  }
  lines.push('```');
  return lines.join('\n');
}

/** Renders one STSO row's cumulative-time line and its histogram diff (this
 * run vs main). Bin width is chosen from this row's own sample range, so every
 * scenario gets a histogram that actually spreads across multiple buckets
 * rather than overflowing into one — except "inline" rows, which use a
 * hardcoded finer width (see STSO_INLINE_BIN_WIDTH_MS). */
function renderStsoRowDiff(row) {
  // Until this lands on `main`, no baseline run has raw samples to diff
  // against. The shape of this run's distribution is still worth showing, so
  // fall back to rendering it as a single series rather than diffing it
  // against itself (which would label this run's own numbers as `main`).
  const selfDiff = !Array.isArray(row.baselineRaw);
  const baselineRaw = selfDiff ? row.raw : row.baselineRaw;

  const maxValue = Math.max(maxOf(row.raw), maxOf(baselineRaw));
  const binWidth = row.scenario.includes('(inline)')
    ? STSO_INLINE_BIN_WIDTH_MS
    : chooseBinWidth(maxValue, STSO_HISTOGRAM_TARGET_BINS);
  // +1 bin of headroom so the max sample lands inside the range rather than
  // exactly on (and thus overflowing) the last edge.
  const binCount = Math.ceil(maxValue / binWidth) + 1;

  const current = buildHistogram(row.raw, binWidth, binCount);
  const baseline = buildHistogram(baselineRaw, binWidth, binCount);
  const currentTotal = sum(row.raw);
  const baselineTotal = sum(baselineRaw);
  const totalDelta = currentTotal - baselineTotal;
  const totalPct =
    baselineTotal > 0 ? (totalDelta / baselineTotal) * 100 : undefined;
  const pctSuffix =
    totalPct === undefined ? '' : `, ${formatDeltaValue(totalPct)}%`;

  const buckets = nonEmptyBuckets(current, baseline, binWidth, binCount);

  const lines = ['', `_${row.scenario}_`, ''];
  if (selfDiff) {
    lines.push(
      `Cumulative STSO time: ${Math.round(currentTotal)}ms over ${row.samples} samples`,
      '',
      "<sub>No `main` baseline with raw samples yet — showing this run's distribution on its own; the diff appears once a run on `main` has recorded them.</sub>",
      ''
    );
  } else {
    lines.push(
      `Cumulative STSO time: main ${Math.round(baselineTotal)}ms → this run ${Math.round(currentTotal)}ms (Δ ${formatDeltaValue(totalDelta, 'ms')}${pctSuffix})`,
      ''
    );
  }
  if (buckets.length > 0) {
    lines.push(renderHistogramBarChart(buckets, { selfDiff }));
  }
  return lines.join('\n');
}

/**
 * Renders a per-scenario histogram diff (bucketed step counts) and a
 * cumulative-time diff (sum of all STSO samples) against `main`, for every
 * STSO row that recorded raw samples — i.e. one for inline steps and one for
 * queue-hop steps. This is a complement to the Best/P75/P90/P99 table:
 * percentiles hide *how many* samples moved and by how much in aggregate,
 * which is exactly where this benchmark's run-to-run variance shows up.
 *
 * Collapsed by default, like the methodology footer — it is a drill-down for
 * when the table shows something worth explaining, not the headline. The
 * blank line after <summary> lets GitHub render the markdown inside.
 */
function renderStsoDiffSection(result) {
  const rows = (result.metrics ?? []).filter(
    (row) => row.metric === 'stso' && Array.isArray(row.raw)
  );
  if (rows.length === 0) return '';
  const anyBaseline = rows.some((row) => Array.isArray(row.baselineRaw));
  return [
    '',
    '<details>',
    `<summary>📈 STSO distribution${anyBaseline ? ' vs main' : ''} (inline / queue-hop histograms)</summary>`,
    '',
    ...rows.map(renderStsoRowDiff),
    '',
    '</details>',
  ].join('\n');
}

// ============================================================================
// CRTT drill-down (per-bucket sparkline matrix, vs main)
// ============================================================================

const SPARK_LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/** One-character-per-bin sparkline over fixed histogram counts, normalized to
 * the row's own max so every bucket's *shape* is readable regardless of its
 * sample count. Empty bins render as `·` so the fixed log axis stays visible
 * and the occupied bins' *position* on it (fast vs slow) is comparable across
 * lines. */
function sparkline(counts) {
  const max = Math.max(1, ...counts);
  return counts
    .map((c) =>
      c === 0
        ? '·'
        : SPARK_LEVELS[
            Math.min(
              SPARK_LEVELS.length - 1,
              Math.floor((c / max) * SPARK_LEVELS.length)
            )
          ]
    )
    .join('');
}

/**
 * Renders the CRTT drill-down: ONE line per variant — a sparkline of the
 * fixed log-bin RTT histogram plus avg/p50/p90/p99 (plain vs-main
 * percentages when a baseline exists) — followed by the mean-RTT profile
 * lines. Per-index detail rows are deliberately NOT rendered: three runs
 * showed them flat and their run-to-run flips are bucket-hopping iteration
 * noise that invites misreads. They stay in the results JSON (with baseline
 * annotations), so when a headline delta fires the artifact still localizes
 * it; the progress line guards position-dependence here with finer
 * resolution than the buckets did.
 *
 * The avg deltas are exact (count-weighted merges on both sides); p50-p99
 * are cross-iteration percentile-of-percentiles, like the main table.
 * Collapsed by default, like the STSO section: a drill-down, not the
 * headline.
 */
function renderCrttMatrixSection(result) {
  const rows = (result.metrics ?? []).filter(
    (row) => row.stream && !row.detail && Array.isArray(row.hist?.counts)
  );
  if (rows.length === 0) return '';
  const anyBaseline = rows.some((row) => typeof row.baselineAvg === 'number');

  const round1 = (v) => Math.round(v * 10) / 10;
  const pct = (cur, base) => {
    if (typeof cur !== 'number' || typeof base !== 'number' || base <= 0) {
      return '';
    }
    const p = ((cur - base) / base) * 100;
    if (Math.abs(p) < 0.5) return ' (±0%)';
    return ` (${p > 0 ? '+' : ''}${Math.round(p)}%)`;
  };
  const cells = (row) => [
    row.group ?? row.scenario,
    sparkline(row.hist.counts),
    `${round1(row.avg)}${pct(row.avg, row.baselineAvg)}`,
    `${formatMs(row.p50)}${pct(row.p50, row.baselineP50)}`,
    `${formatMs(row.p90)}${pct(row.p90, row.baselineP90)}`,
    `${formatMs(row.p99)}${pct(row.p99, row.baselineP99)}`,
    String(row.samples),
  ];
  const header = ['variant', 'RTT 1ms→5s+', 'avg', 'p50', 'p90', 'p99', 'n'];
  const table = [header, ...rows.map(cells)];
  const widths = header.map((_, col) =>
    Math.max(...table.map((line) => line[col].length))
  );
  const renderLine = (line) =>
    line
      .map((cell, col) =>
        // Left-align the label and sparkline columns, right-align numbers.
        col <= 1 ? cell.padEnd(widths[col]) : cell.padStart(widths[col])
      )
      .join('  ')
      .trimEnd();

  const lines = ['```', renderLine(header)];
  for (const row of rows) {
    lines.push(renderLine(cells(row)));
  }
  lines.push('```');

  // Mean-RTT profile lines, one per variant that recorded the profile:
  // - progress (per tenth of the stream): the drift readout — a rising
  //   staircase means chunks get slower as the stream grows, which fixed
  //   index buckets can't localize.
  // - size (per log size bin, sweep only): the size→latency curve — flat
  //   means chunk size doesn't matter, a knee localizes where it starts to.
  // Bars are scaled min→max per line so the *shape* stays readable even for
  // small effects; the ms range alongside is what says whether the shape
  // matters. Null entries (empty bins) render as `·`.
  const renderProfileBlock = (title, entries) => {
    if (entries.length === 0) return;
    const labelWidth = Math.max(...entries.map((e) => e.label.length));
    lines.push('', title, '', '```');
    for (const { label, avgs } of entries) {
      const present = avgs.filter((v) => typeof v === 'number');
      if (present.length === 0) continue;
      const min = Math.min(...present);
      const max = Math.max(...present);
      const span = max - min;
      const bars = avgs
        .map((v) =>
          typeof v !== 'number'
            ? '·'
            : span <= 0
              ? SPARK_LEVELS[0]
              : SPARK_LEVELS[
                  Math.round(((v - min) / span) * (SPARK_LEVELS.length - 1))
                ]
        )
        .join('');
      const range = `${Math.round(min)}–${Math.round(max)}ms`;
      lines.push(`${label.padEnd(labelWidth)}  ${bars}  ${range}`);
    }
    lines.push('```');
  };
  const profileEntries = (field) =>
    rows
      .filter((row) => Array.isArray(row[field]) && row[field].length > 0)
      .map((row) => ({ label: row.group ?? row.scenario, avgs: row[field] }));
  renderProfileBlock(
    'RTT over stream progress (avg per tenth of stream, bars scaled min→max):',
    profileEntries('progressAvgMs')
  );
  renderProfileBlock(
    'RTT by chunk size (avg per log size bin, ~160B → ~12KB serialized, bars scaled min→max):',
    profileEntries('sizeAvgMs')
  );
  // Where in the stream delivery clumping/stalls concentrate — the CDV
  // row's per-run max says the worst stall's size; this says where. Flat is
  // steady-cadence clumping; a hot spot localizes a stall.
  renderProfileBlock(
    'Delivery jitter over stream progress (avg positive CDV per tenth of stream, bars scaled min→max):',
    profileEntries('cdvAvgMs')
  );

  return [
    '',
    '<details>',
    `<summary>📈 CRTT drill-down${anyBaseline ? ' vs main' : ''} (RTT distributions & profiles)</summary>`,
    '',
    ...(anyBaseline
      ? []
      : [
          '<sub>No `main` baseline yet — percentages appear once a run on `main` has recorded CRTT.</sub>',
          '',
        ]),
    lines.join('\n'),
    '',
    '</details>',
  ].join('\n');
}

// Deltas beyond ±this vs main get a directional marker: 🔻 for a regression,
// 💚 for an improvement. Smaller moves show the percentage alone.
const DELTA_MARK_THRESHOLD_PCT = 15;

/**
 * Formats a vs-main delta, e.g. " (+4.2%)"; empty without a baseline. Moves
 * worse than +15% are flagged 🔻 and moves better than -15% are flagged 💚.
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

// CDV (and, in older history entries, Slip) is the companion of CRTT,
// measured by the same scenario runs (same workload, same iterations). The
// table pairs each variant's rows — chunk RTT (llm) directly above delivery
// jitter (llm) — instead of grouping metric by metric.
const PAIRED_METRICS = { cdv: 'crtt', slip: 'crtt' };

function metricSortKey(row) {
  const idx = METRIC_ORDER.indexOf(PAIRED_METRICS[row.metric] ?? row.metric);
  return idx === -1 ? METRIC_ORDER.length : idx;
}

/** Orders rows within a paired-metric family: by variant (`group`, falling
 * back to scenario for rows recorded before `group` existed), then anchor
 * metric before companion. Non-family rows keep insertion order (0 preserves
 * the stable sort). */
function pairedSortKey(a, b) {
  const inFamily = (metric) =>
    metric in PAIRED_METRICS || Object.values(PAIRED_METRICS).includes(metric);
  if (!inFamily(a.metric) || !inFamily(b.metric)) return 0;
  return (
    (a.group ?? a.scenario).localeCompare(b.group ?? b.scenario) ||
    METRIC_ORDER.indexOf(a.metric) - METRIC_ORDER.indexOf(b.metric)
  );
}

/**
 * The stream-scenario table: one row per stream scenario, with the columns
 * streams actually want — CRTT percentiles and the median worst delivery
 * stall (CDV max positive).
 * Deltas vs main are plain percentages; deliberately NO 🔴/🟢 marks — targets
 * attach in a later PR once a baseline exists. Rates read higher-is-better,
 * latencies lower-is-better, so directional marks would need per-column
 * polarity anyway; numbers + deltas keep it honest until then.
 */
function renderStreamTable(result) {
  const rows = (result.metrics ?? []).filter(
    (row) => row.stream && !row.detail
  );
  if (rows.length === 0) return '';
  const pct = (cur, base) => {
    if (typeof cur !== 'number' || typeof base !== 'number' || base <= 0) {
      return '';
    }
    const p = ((cur - base) / base) * 100;
    if (Math.abs(p) < 0.5) return ' (±0%)';
    return ` (${p > 0 ? '+' : ''}${Math.round(p)}%)`;
  };
  const cell = (value, base) =>
    typeof value === 'number' ? `${formatMs(value)}${pct(value, base)}` : '—';
  const lines = [
    '**Streams**',
    '',
    '| Scenario | CRTT 1st | p75 | p90 | p99 | CDV max | iters |',
    '|----------|---------:|----:|----:|----:|--------:|------:|',
  ];
  for (const row of rows) {
    const s = row.stream;
    const b = row.baselineStream ?? {};
    lines.push(
      `| ${row.scenario} | ${cell(s.firstMs, b.firstMs)} | ${cell(row.p75, row.baselineP75)} | ${cell(row.p90, row.baselineP90)} | ${cell(row.p99, row.baselineP99)} | ${cell(s.cdvMaxMs, b.cdvMaxMs)} | ${s.iterations} |`
    );
  }
  return lines.join('\n');
}

function renderResultTable(result) {
  const lines = [
    '| Metric | Scenario | Best (ms) | P75 (ms) | P90 (ms) | P99 (ms) | Samples |',
    '|--------|----------|----------:|---------:|---------:|---------:|--------:|',
  ];
  // Drill-down rows (e.g. CRTT's per-bucket splits) and stream rows (their
  // own table) stay out of the headline table.
  const rows = result.metrics
    .filter((row) => !row.detail && !row.stream)
    .sort((a, b) => metricSortKey(a) - metricSortKey(b) || pairedSortKey(a, b));
  if (rows.length === 0) return '';
  for (const row of rows) {
    const label = METRIC_LABELS[row.metric];
    // Abbreviations only — the definitions live in the comment footer.
    const name = label ? `**${label.name}**` : row.metric;
    const targets = row.targets ?? {};
    // Deltas vs main are shown on Best/P75/P90/P99.
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
    const resultTable = renderResultTable(result);
    if (resultTable) lines.push(resultTable, '');
    const streamTable = renderStreamTable(result);
    if (streamTable) lines.push(streamTable, '');
    // Only the latest entry carries raw samples and histograms (they are
    // stripped before being embedded in the comment's data block, see
    // stripRawSamples), so these render for the current run and are silently
    // skipped for the collapsed history entries.
    const stsoDiff = renderStsoDiffSection(result);
    if (stsoDiff) lines.push(stsoDiff, '');
    const crttDiff = renderCrttMatrixSection(result);
    if (crttDiff) lines.push(crttDiff, '');
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

/**
 * Replay-cadence identity line: capture id + full semantic sha256 (the
 * cross-system workload fingerprint — durabench computes the same hash over
 * its copy of the capture; see cadenceSemanticSha256 in benchmark.test.ts).
 * Rendered as its own line so the full hash is findable and copyable rather
 * than buried in the scenario prose.
 */
function buildCadencesLegend(results) {
  const cadences = new Map();
  for (const result of results) {
    for (const c of result.config?.replayCadences ?? []) {
      if (c?.id && c?.semanticSha256 && !cadences.has(c.id)) {
        cadences.set(c.id, c.semanticSha256);
      }
    }
  }
  return [...cadences].map(([id, sha]) => `**${id}** \`${sha}\``).join(' · ');
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
  // Only define the metrics this comment actually shows — retired metrics
  // (e.g. SL/SO, superseded by CRTT) stay defined in METRIC_LABELS so older
  // history entries keep rendering, but they drop out of the legend once the
  // latest run no longer reports them.
  // Only rendered rows feed the legend — artifact-only detail rows (e.g.
  // per-index CRTT splits, slip tails) don't define terms the comment never
  // shows.
  const presentMetrics = new Set(
    results.flatMap((result) =>
      (result.metrics ?? [])
        .filter((row) => !row.detail)
        .map((row) => row.metric)
    )
  );
  // The stream table's columns are CRTT percentiles and CDV max, so those
  // definitions stay in the legend whenever stream rows render even though
  // no row carries those metric ids anymore.
  if (results.some((result) => (result.metrics ?? []).some((r) => r.stream))) {
    presentMetrics.add('crtt');
    presentMetrics.add('cdv');
    presentMetrics.delete('stream');
  }
  const definitions = METRIC_ORDER.filter((id) => presentMetrics.has(id))
    .map(
      (id) => `**${METRIC_LABELS[id].name}**: ${METRIC_LABELS[id].description}`
    )
    .join(' · ');
  const scenarioLegend = buildScenarioLegend(results);
  const cadencesLegend = buildCadencesLegend(results);
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

  const hasStsoDistribution = results.some((result) =>
    (result.metrics ?? []).some(
      (row) => row.metric === 'stso' && Array.isArray(row.raw)
    )
  );

  const hasCrttDistribution = results.some((result) =>
    (result.metrics ?? []).some(
      (row) => row.stream && Array.isArray(row.hist?.counts)
    )
  );

  const hasStreamTable = results.some((result) =>
    (result.metrics ?? []).some((row) => row.stream)
  );

  const smallprint = [
    ...(hasStreamTable
      ? [
          '<sub>**Streams**: first-chunk RTT (the stream-open path, before any buffering/backpressure), CRTT percentiles, and worst delivery stall (CDV max). Cells are medians across iterations; per-run values in the artifacts. No \ud83d\udd34/\ud83d\udfe2 marks until targets attach.</sub>',
          '',
        ]
      : []),
    ...(hasStsoDistribution
      ? [
          '<sub>The collapsed **STSO distribution** section above buckets every step gap, split **inline** (same warm process — pure framework overhead) vs **queue-hop** (fresh process — dispatch, reinit, replay). `█` = `main`, `┃` = this run, `░` = fill.</sub>',
          '',
        ]
      : []),
    ...(hasCrttDistribution
      ? [
          '<sub>The collapsed **CRTT drill-down**: per-variant RTT histograms (fixed log bins, `·` = empty) and mean RTT/positive-CDV profile lines over stream progress and chunk size. Histograms, avgs, and profiles merge exactly across runs; p50–p99 are percentile-of-percentiles. Per-index rows live in the artifacts.</sub>',
          '',
        ]
      : []),
    ...(hasBaseline
      ? [
          '<sub>Best/P75/P90/P99 deltas compare against the most recent benchmark run on `main` at the time of this run. 🔻 flags a delta worse than +15%, 💚 one better than −15%.</sub>',
          '',
        ]
      : []),
    `<sub>Metrics — ${definitions}</sub>`,
    ...(scenarioLegend ? ['', `<sub>Scenarios — ${scenarioLegend}</sub>`] : []),
    ...(cadencesLegend
      ? ['', `<sub>Replay cadences (semantic sha256) — ${cadencesLegend}</sub>`]
      : []),
    ...(targetsLegend
      ? [
          '',
          `<sub>🔴 marks a percentile over its target (within target is left unmarked). Targets (p75/p90/p99, ms) — ${targetsLegend}</sub>`,
        ]
      : []),
    '',
    '<sub>All timestamps are deployment-side; runs are triggered in-deployment, so the CI runner and api.vercel.com sit outside every measured window. TTFS = `start()` → first step body (includes dispatch + any cold start); Fan-out TTFS/TTLS = first/last step completion of one `Promise.all` from the same anchor (the gap is the runtime’s fan-out spread); STSO/WO between step bodies; CRTT inside the workflow (excludes the api.vercel.com read path).</sub>',
    '',
    '<sub>Cold starts stay in the numbers (real bursty-workload latency, inflates P75+); **Best** is the warm floor.</sub>',
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
