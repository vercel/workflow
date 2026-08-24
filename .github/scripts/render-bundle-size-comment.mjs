#!/usr/bin/env node
/**
 * Renders the sticky PR comment for the Bundle Size workflow and emits a
 * machine-readable gate verdict.
 *
 * Reads the JSON reports produced by measure-flow-bundle.mjs for the PR head,
 * plus the same reports downloaded from the most recent successful run on
 * main, and diffs them. Tier-1 metrics are gated: the verdict marks a
 * regression when a gated metric's raw size grew by more than
 * max(--threshold-pct, --threshold-bytes) against the baseline.
 *
 * The comment is one table, one row per app, one column per metric, and
 * nothing else but footnotes. Cells show **gzip** with the change against main
 * in parentheses. Note the deliberate asymmetry: the cells are gzip because
 * that is the number worth reading at a glance, while the gate compares raw
 * bytes, which is what the runtime actually parses on a cold start. A footnote
 * says so, because otherwise a red check with a small gzip delta next to it
 * looks like a bug.
 *
 * Reports whose build fingerprints disagree are never diffed. The fingerprint
 * records the env that changes the measured bytes (target world, sourcemap
 * mode, public manifest, Node major); comparing across a change to any of
 * those produces a large, entirely meaningless delta.
 *
 * Usage:
 *   node .github/scripts/render-bundle-size-comment.mjs \
 *     --results-dir size-results --baseline-dir baseline-results \
 *     --commit "$SHA" --run-url "$URL" \
 *     --output comment.md --gate-output gate.json
 */

import fs from 'node:fs';
import path from 'node:path';

export const COMMENT_MARKER = '<!-- bundle-size-results -->';

/** Matches the workflow defaults; both are overridable on the command line. */
export const DEFAULT_THRESHOLD_PCT = 2;
export const DEFAULT_THRESHOLD_BYTES = 50 * 1024;

const SUPPORTED_SCHEMA_VERSION = 1;

const STRING_FLAGS = {
  '--results-dir': 'resultsDir',
  '--baseline-dir': 'baselineDir',
  '--commit': 'commit',
  '--run-url': 'runUrl',
  '--output': 'output',
  '--gate-output': 'gateOutput',
  '--status': 'status',
};

const NUMBER_FLAGS = {
  '--threshold-pct': 'thresholdPct',
  '--threshold-bytes': 'thresholdBytes',
};

export function parseArgs(argv) {
  const args = {
    resultsDir: null,
    baselineDir: null,
    commit: null,
    runUrl: null,
    output: null,
    gateOutput: null,
    status: 'completed',
    thresholdPct: DEFAULT_THRESHOLD_PCT,
    thresholdBytes: DEFAULT_THRESHOLD_BYTES,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (STRING_FLAGS[flag]) args[STRING_FLAGS[flag]] = argv[++i];
    else if (NUMBER_FLAGS[flag]) args[NUMBER_FLAGS[flag]] = Number(argv[++i]);
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (!args.resultsDir) throw new Error('Missing required --results-dir');
  if (!args.output) throw new Error('Missing required --output');
  if (!Number.isFinite(args.thresholdPct) || args.thresholdPct < 0) {
    throw new Error('--threshold-pct must be a non-negative number');
  }
  if (!Number.isFinite(args.thresholdBytes) || args.thresholdBytes < 0) {
    throw new Error('--threshold-bytes must be a non-negative number');
  }
  return args;
}

function findJsonFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.json')) out.push(full);
    }
  }
  return out.sort();
}

/**
 * Loads every *.json report under a directory, keyed by app.
 *
 * Recursive on purpose: `actions/download-artifact` with `merge-multiple`
 * flattens reports into one directory, but `gh run download` puts each
 * artifact in its own subdirectory, and the baseline arrives via the latter.
 *
 * A directory that does not exist yields an empty map: no baseline is a valid
 * state (first run, expired artifact, fork PR). A malformed or future-schema
 * report is skipped rather than crashing the comment, so the rest of the
 * numbers still get posted.
 */
export function loadReports(dir) {
  const reports = new Map();
  const skipped = [];
  if (!dir || !fs.existsSync(dir)) return { reports, skipped };

  for (const full of findJsonFiles(dir)) {
    const name = path.relative(dir, full);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (error) {
      skipped.push(`${name} (unparseable: ${error.message})`);
      continue;
    }
    if (parsed?.schemaVersion !== SUPPORTED_SCHEMA_VERSION) {
      skipped.push(`${name} (schemaVersion ${parsed?.schemaVersion})`);
      continue;
    }
    if (typeof parsed.app !== 'string' || !Array.isArray(parsed.metrics)) {
      skipped.push(`${name} (missing app or metrics)`);
      continue;
    }
    reports.set(parsed.app, parsed);
  }
  return { reports, skipped };
}

export function fingerprintsMatch(a, b) {
  if (!a || !b) return false;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  return keys.every((key) => (a[key] ?? null) === (b[key] ?? null));
}

export function formatBytes(bytes) {
  const abs = Math.abs(bytes);
  if (abs < 1024) return `${bytes} B`;
  if (abs < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatSignedBytes(bytes) {
  return bytes >= 0 ? `+${formatBytes(bytes)}` : `-${formatBytes(-bytes)}`;
}

/**
 * Diffs one app's report against its baseline and decides which gated metrics
 * regressed. A metric absent from the baseline (newly added) is reported with
 * no delta and never gates, since there is nothing to compare against.
 */
export function compareApp(current, baseline, thresholds) {
  const mismatch =
    baseline && !fingerprintsMatch(current.fingerprint, baseline.fingerprint);
  const baselineMetrics = new Map(
    (baseline?.metrics ?? []).map((metric) => [metric.id, metric])
  );
  const comparable = Boolean(baseline) && !mismatch;

  const rows = current.metrics.map((metric) => {
    const base = comparable ? baselineMetrics.get(metric.id) : undefined;
    const row = {
      id: metric.id,
      label: metric.label ?? metric.id,
      tier: metric.tier,
      gated: Boolean(metric.gated),
      note: metric.note ?? null,
      raw: metric.raw,
      gzip: metric.gzip,
      baselineRaw: base?.raw ?? null,
      baselineGzip: base?.gzip ?? null,
      rawDelta: null,
      gzipDelta: null,
      threshold: null,
      regression: false,
    };
    if (base) {
      row.rawDelta = metric.raw - base.raw;
      row.gzipDelta = metric.gzip - base.gzip;
      row.threshold = Math.max(
        (base.raw * thresholds.pct) / 100,
        thresholds.bytes
      );
      row.regression = row.gated && row.rawDelta > row.threshold;
    }
    return row;
  });

  return {
    app: current.app,
    hasBaseline: Boolean(baseline),
    fingerprintMismatch: mismatch
      ? { current: current.fingerprint, baseline: baseline.fingerprint }
      : null,
    rows,
  };
}

export function compareAll(currentReports, baselineReports, thresholds) {
  const apps = [...currentReports.keys()]
    .sort()
    .map((app) =>
      compareApp(currentReports.get(app), baselineReports.get(app), thresholds)
    );
  const regressions = apps.flatMap((entry) =>
    entry.rows
      .filter((row) => row.regression)
      .map((row) => ({
        app: entry.app,
        id: row.id,
        label: row.label,
        rawDelta: row.rawDelta,
        threshold: row.threshold,
        baselineRaw: row.baselineRaw,
        raw: row.raw,
      }))
  );
  return { apps, regressions };
}

/**
 * Columns of the results table, in order, keyed by metric id so a report
 * missing a metric renders an empty cell instead of shifting the whole row.
 */
const COLUMNS = [
  { id: 'flow-bundle', label: 'Flow route' },
  { id: 'step-registrations', label: 'Step reg.' },
  { id: 'framework-output', label: 'Framework output' },
];

/**
 * One cell: the gzip size, then the change against main in parentheses. The
 * parentheses are dropped when there is nothing to compare against, which is
 * the case on a first run, an expired baseline, and a fingerprint mismatch.
 */
function renderCell(row) {
  if (!row) return '—';
  const size = formatBytes(row.gzip);
  const marker = row.regression ? ' ⚠️' : '';
  if (row.gzipDelta === null || row.gzipDelta === undefined) {
    return `${size}${marker}`;
  }
  const delta = row.gzipDelta === 0 ? '±0' : formatSignedBytes(row.gzipDelta);
  return `${size} (${delta})${marker}`;
}

function fingerprintDiffKeys(mismatch) {
  return Object.keys(mismatch.current).filter(
    (key) =>
      (mismatch.current[key] ?? null) !== (mismatch.baseline[key] ?? null)
  );
}

export function renderComment({
  comparison,
  commit,
  runUrl,
  status = 'completed',
  thresholds,
  skipped = [],
}) {
  const lines = [COMMENT_MARKER];

  if (comparison.apps.length === 0) {
    lines.push(`No measurements were produced. See the [run log](${runUrl}).`);
    return `${lines.join('\n')}\n`;
  }

  lines.push(
    `| Framework | ${COLUMNS.map((column) => column.label).join(' | ')} |`,
    `| --- |${COLUMNS.map(() => ' ---: |').join('')}`
  );
  for (const entry of comparison.apps) {
    const byId = new Map(entry.rows.map((row) => [row.id, row]));
    const cells = COLUMNS.map((column) => renderCell(byId.get(column.id)));
    lines.push(`| ${entry.app} | ${cells.join(' | ')} |`);
  }

  // Footnotes carry only what the table cannot say for itself: what the
  // numbers are, what the parentheses are, and what makes the job fail.
  const anyBaseline = comparison.apps.some((entry) => entry.hasBaseline);
  lines.push(
    '',
    anyBaseline
      ? 'Sizes are gzip; parentheses show the change against `main`.'
      : 'Sizes are gzip.',
    `Flow route and Step reg. gate this job, on raw bytes rather than the gzip ` +
      `shown, at max(${thresholds.pct}%, ${formatBytes(thresholds.bytes)}). ` +
      'Framework output is informational.'
  );

  if (status === 'failed') {
    lines.push('A measurement job failed, so these numbers may be incomplete.');
  }
  if (comparison.regressions.length > 0) {
    lines.push(
      '⚠️ marks growth past the threshold. Add the ' +
        '`allow-bundle-size-growth` label to accept it.'
    );
  }
  for (const entry of comparison.apps) {
    if (entry.fingerprintMismatch) {
      lines.push(
        `${entry.app}: build fingerprint differs from the baseline ` +
          `(${fingerprintDiffKeys(entry.fingerprintMismatch).join(', ')}), ` +
          'so no change is shown.'
      );
    }
  }
  if (comparison.apps.some((entry) => !entry.hasBaseline)) {
    lines.push('No baseline on `main` yet for some rows.');
  }
  if (skipped.length > 0) {
    lines.push(`Skipped unreadable reports: ${skipped.join(', ')}.`);
  }

  const shortCommit = commit ? commit.slice(0, 7) : 'unknown';
  lines.push('', `\`${shortCommit}\` · [run](${runUrl})`);

  return `${lines.join('\n')}\n`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const thresholds = { pct: args.thresholdPct, bytes: args.thresholdBytes };

  const current = loadReports(args.resultsDir);
  const baseline = loadReports(args.baselineDir);
  const comparison = compareAll(current.reports, baseline.reports, thresholds);

  const markdown = renderComment({
    comparison,
    commit: args.commit,
    runUrl: args.runUrl,
    status: args.status,
    thresholds,
    skipped: current.skipped,
  });

  fs.writeFileSync(args.output, markdown);
  process.stdout.write(markdown);

  if (args.gateOutput) {
    fs.writeFileSync(
      args.gateOutput,
      `${JSON.stringify(
        {
          regressions: comparison.regressions,
          measuredApps: comparison.apps.map((entry) => entry.app),
          thresholds,
        },
        null,
        2
      )}\n`
    );
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === new URL(import.meta.url).pathname
) {
  main();
}
