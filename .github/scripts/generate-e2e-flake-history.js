#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');

const MAX_RUNS = 30;
const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_INPUT_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REPORT_FILES = 512;
const SCHEMA_VERSION = 1;

function parseArgs(argv) {
  const options = {
    resultsDir: '.',
    previous: null,
    output: 'e2e-flake-history.json',
    runId: process.env.GITHUB_RUN_ID || '',
    attempt: process.env.GITHUB_RUN_ATTEMPT || '1',
    sha: process.env.GITHUB_SHA || '',
    startedAt: process.env.GITHUB_RUN_STARTED_AT || new Date().toISOString(),
    runUrl: '',
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--results-dir') options.resultsDir = value;
    else if (key === '--previous') options.previous = value;
    else if (key === '--output') options.output = value;
    else if (key === '--run-id') options.runId = value;
    else if (key === '--attempt') options.attempt = value;
    else if (key === '--sha') options.sha = value;
    else if (key === '--started-at') options.startedAt = value;
    else if (key === '--run-url') options.runUrl = value;
    else continue;
    i++;
  }
  return options;
}

function findReports(dir) {
  const reports = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) reports.push(...findReports(full));
    else if (
      entry.isFile() &&
      entry.name.startsWith('e2e-') &&
      entry.name.endsWith('.json') &&
      !entry.name.endsWith('.flaky.json') &&
      !/^(e2e-(?:metadata|failures|flaky|infra|diagnostics|runtime-logs)-|e2e-conformance\.)/.test(
        entry.name
      )
    ) {
      reports.push(full);
    }
  }
  return reports.sort();
}

const DIMENSION_PATTERNS = [
  [
    /^e2e-vercel-prod-(.+)-(node|quickjs)$/,
    (match) => ({
      lane: 'vercel-prod',
      app: match[1],
      world: 'vercel',
      vm: match[2],
      platform: 'vercel',
      variant: 'production',
    }),
  ],
  [
    /^e2e-vercel-(ws|http)-transport-(.+)$/,
    (match) => ({
      lane: `vercel-${match[1]}-transport`,
      app: match[2],
      world: 'vercel',
      vm: 'node',
      platform: 'vercel',
      variant: match[1],
    }),
  ],
  [
    /^e2e-vercel-multi-region-(.+)$/,
    (match) => ({
      lane: 'vercel-multi-region',
      app: match[1],
      world: 'vercel',
      vm: 'node',
      platform: 'vercel',
      variant: 'multi-region',
    }),
  ],
  [
    /^e2e-local-(dev|prod)-(.+)-(stable|canary(?:-lazy-discovery-(?:enabled|disabled))?)-(node|quickjs)$/,
    (match) => ({
      lane: `local-${match[1]}`,
      app: match[2],
      world: 'local',
      vm: match[4],
      platform: 'linux',
      variant: match[3],
    }),
  ],
  [
    /^e2e-local-postgres-(.+)-(stable|canary(?:-lazy-discovery-(?:enabled|disabled))?)-(node|quickjs)$/,
    (match) => ({
      lane: 'local-postgres',
      app: match[1],
      world: 'postgres',
      vm: match[3],
      platform: 'linux',
      variant: match[2],
    }),
  ],
  [
    /^e2e-local-(dev|prod)-(.+)-(node|quickjs)$/,
    (match) => ({
      lane: `local-${match[1]}`,
      app: match[2],
      world: 'local',
      vm: match[3],
      platform: 'linux',
    }),
  ],
  [
    /^e2e-local-postgres-(.+)-(node|quickjs)$/,
    (match) => ({
      lane: 'local-postgres',
      app: match[1],
      world: 'postgres',
      vm: match[2],
      platform: 'linux',
    }),
  ],
  [
    /^e2e-community-(.+)-dev$/,
    (match) => ({
      lane: 'community-dev',
      app: match[1],
      world: match[1],
      vm: 'node',
      platform: 'linux',
    }),
  ],
  [
    /^e2e-community-(.+)$/,
    (match) => ({
      lane: 'community',
      app: match[1],
      world: match[1],
      vm: 'node',
      platform: 'linux',
    }),
  ],
  [
    /^e2e-windows-(.+)-(node|quickjs)$/,
    (match) => ({
      lane: 'windows',
      app: match[1],
      world: 'local',
      vm: match[2],
      platform: 'windows',
    }),
  ],
];

function dimensionFor(filename) {
  const stem = path.basename(filename, '.json');
  if (stem === 'e2e-conformance-python') {
    return {
      lane: 'conformance',
      app: 'python',
      world: 'local',
      vm: 'python',
      platform: 'linux',
    };
  }
  for (const [pattern, createDimension] of DIMENSION_PATTERNS) {
    const match = stem.match(pattern);
    if (match) return createDimension(match);
  }
  return null;
}

function normalizeFile(file) {
  if (!file) return 'unknown';
  const normalized = file.replaceAll('\\', '/');
  const marker = '/packages/';
  const workbenchMarker = '/workbench/';
  const index = normalized.lastIndexOf(marker);
  if (index >= 0) return normalized.slice(index + 1);
  const workbenchIndex = normalized.lastIndexOf(workbenchMarker);
  if (workbenchIndex >= 0) return normalized.slice(workbenchIndex + 1);
  return normalized.replace(/^\.\//, '');
}

function validatePreviousHistory(history) {
  const validRun = (run) =>
    run &&
    typeof run.id === 'string' &&
    Number.isFinite(run.runId) &&
    Number.isFinite(run.attempt) &&
    typeof run.startedAt === 'string';
  const validDimension = (dimension) =>
    dimension &&
    typeof dimension.lane === 'string' &&
    typeof dimension.app === 'string' &&
    typeof dimension.world === 'string' &&
    typeof dimension.vm === 'string' &&
    typeof dimension.platform === 'string';
  const validTest = (test) =>
    test && typeof test.file === 'string' && typeof test.name === 'string';
  const validSeries = (series) =>
    Array.isArray(series) &&
    series.length === 6 &&
    Number.isInteger(series[0]) &&
    series[0] >= 0 &&
    series[0] < history.dimensions.length &&
    Number.isInteger(series[1]) &&
    series[1] >= 0 &&
    series[1] < history.tests.length &&
    Number.isInteger(series[2]) &&
    Number.isInteger(series[3]) &&
    typeof series[4] === 'string' &&
    /^[0-9a-f]+$/i.test(series[4]) &&
    typeof series[5] === 'string' &&
    /^[0-9a-f]+$/i.test(series[5]);

  return (
    history.schemaVersion === SCHEMA_VERSION &&
    Array.isArray(history.runs) &&
    history.runs.length <= MAX_RUNS &&
    history.runs.every(validRun) &&
    Array.isArray(history.dimensions) &&
    history.dimensions.every(validDimension) &&
    Array.isArray(history.tests) &&
    history.tests.every(validTest) &&
    Array.isArray(history.series) &&
    history.series.every(validSeries)
  );
}

function readPrevious(filename) {
  if (!filename || !fs.existsSync(filename)) return null;
  const stat = fs.statSync(filename);
  if (stat.size === 0) return null;
  if (stat.size > 10 * 1024 * 1024) {
    throw new Error('Previous flake history exceeds the 10 MiB safety limit');
  }
  const parsed = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!validatePreviousHistory(parsed)) {
    throw new Error(
      'Previous flake history uses an unsupported or corrupt schema'
    );
  }
  return parsed;
}

function bitSet(mask, index) {
  return (BigInt(`0x${mask || '0'}`) & (1n << BigInt(index))) !== 0n;
}

function dimensionKey(dimension) {
  return JSON.stringify(dimension);
}
function testKey(test) {
  return `${test.file}\u0000${test.name}`;
}
function observationKey(dimension, test) {
  return `${dimensionKey(dimension)}\u0001${testKey(test)}`;
}

function previousObservations(history) {
  const observations = new Map();
  if (!history) return observations;
  for (const [
    dimensionIndex,
    testIndex,
    ,
    ,
    executedMask,
    retryMask,
  ] of history.series) {
    const dimension = history.dimensions[dimensionIndex];
    const test = history.tests[testIndex];
    if (!dimension || !test) continue;
    const key = observationKey(dimension, test);
    const value = { dimension, test, executed: new Set(), retried: new Set() };
    history.runs.forEach((run, index) => {
      if (bitSet(executedMask, index)) value.executed.add(run.id);
      if (bitSet(retryMask, index)) value.retried.add(run.id);
    });
    observations.set(key, value);
  }
  return observations;
}

function readJsonInput(filename, budget) {
  const size = fs.statSync(filename).size;
  if (size > MAX_INPUT_FILE_BYTES) {
    throw new Error('file exceeds the 2 MiB input limit');
  }
  budget.bytes += size;
  if (budget.bytes > MAX_INPUT_BYTES) {
    throw new Error('inputs exceed the 10 MiB aggregate limit');
  }
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function validateReport(report) {
  if (!report || !Array.isArray(report.testResults)) {
    throw new Error('missing testResults');
  }
  for (const testFile of report.testResults) {
    if (
      !testFile ||
      typeof testFile.name !== 'string' ||
      !Array.isArray(testFile.assertionResults)
    ) {
      throw new Error('invalid test result');
    }
    for (const assertion of testFile.assertionResults) {
      if (
        !assertion ||
        typeof assertion.status !== 'string' ||
        (typeof assertion.fullName !== 'string' &&
          typeof assertion.title !== 'string')
      ) {
        throw new Error('invalid assertion result');
      }
    }
  }
}

function validateFlakyEntries(entries) {
  if (!Array.isArray(entries)) throw new Error('expected an array');
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry.file !== 'string' ||
      (typeof entry.fullName !== 'string' && typeof entry.testName !== 'string')
    ) {
      throw new Error('invalid retry entry');
    }
  }
}

function addReportObservations(
  report,
  flakyEntries,
  dimension,
  runId,
  observations
) {
  const retried = new Set(
    flakyEntries.map(
      (entry) =>
        `${normalizeFile(entry.file)}\u0000${entry.fullName || entry.testName}`
    )
  );
  for (const testFile of report.testResults) {
    for (const assertion of testFile.assertionResults) {
      if (assertion.status !== 'passed' && assertion.status !== 'failed') {
        continue;
      }
      const test = {
        file: normalizeFile(testFile.name),
        name: assertion.fullName || assertion.title,
      };
      const key = observationKey(dimension, test);
      const value = observations.get(key) || {
        dimension,
        test,
        executed: new Set(),
        retried: new Set(),
      };
      value.executed.add(runId);
      if (assertion.status === 'passed' && retried.has(testKey(test))) {
        value.retried.add(runId);
      }
      observations.set(key, value);
    }
  }
}

function loadCurrent(resultsDir, runId, observations) {
  const reports = findReports(resultsDir);
  if (reports.length > MAX_REPORT_FILES) {
    throw new Error(`Found more than ${MAX_REPORT_FILES} E2E reports`);
  }
  const budget = { bytes: 0 };
  let validReports = 0;
  for (const reportFile of reports) {
    const dimension = dimensionFor(reportFile);
    if (!dimension) {
      console.warn(
        `Skipping report with unknown dimensions: ${path.basename(reportFile)}`
      );
      continue;
    }
    const flakyFile = reportFile.replace(/\.json$/, '.flaky.json');
    if (!fs.existsSync(flakyFile)) {
      console.warn(
        `Skipping report without paired retry telemetry: ${path.basename(reportFile)}`
      );
      continue;
    }
    try {
      const report = readJsonInput(reportFile, budget);
      const flakyEntries = readJsonInput(flakyFile, budget);
      validateReport(report);
      validateFlakyEntries(flakyEntries);
      addReportObservations(
        report,
        flakyEntries,
        dimension,
        runId,
        observations
      );
      validReports++;
    } catch (error) {
      if (error.message.includes('aggregate limit')) throw error;
      console.warn(
        `Skipping invalid report pair ${reportFile}: ${error.message}`
      );
    }
  }
  return validReports;
}

function popcount(mask) {
  let value = mask;
  let count = 0;
  while (value) {
    count += Number(value & 1n);
    value >>= 1n;
  }
  return count;
}

function buildHistory(options) {
  const previous = readPrevious(options.previous);
  const observations = previousObservations(previous);
  const run = {
    id: `${options.runId}.${options.attempt}`,
    runId: Number(options.runId),
    attempt: Number(options.attempt),
    sha: options.sha,
    startedAt: options.startedAt,
    url: options.runUrl,
  };
  if (!options.runId || !Number.isFinite(run.runId))
    throw new Error('--run-id is required');

  // A repeated publication for the same workflow attempt replaces that
  // attempt's observations instead of preserving stale retry bits.
  for (const value of observations.values()) {
    value.executed.delete(run.id);
    value.retried.delete(run.id);
  }
  const validReports = loadCurrent(options.resultsDir, run.id, observations);
  if (validReports === 0) {
    console.warn(
      'No valid E2E reports found; leaving previous history unchanged'
    );
    if (!previous) throw new Error('No valid reports and no previous history');
    return previous;
  }

  const runsById = new Map(
    (previous?.runs || []).map((item) => [item.id, item])
  );
  runsById.set(run.id, run);
  const runs = [...runsById.values()]
    .sort(
      (a, b) =>
        a.startedAt.localeCompare(b.startedAt) ||
        a.runId - b.runId ||
        a.attempt - b.attempt
    )
    .slice(-MAX_RUNS);
  const retained = new Set(runs.map((item) => item.id));
  const runIndex = new Map(runs.map((item, index) => [item.id, index]));

  const dimensions = [];
  const tests = [];
  const dimensionIndexes = new Map();
  const testIndexes = new Map();
  const series = [];
  for (const value of observations.values()) {
    const executed = [...value.executed].filter((id) => retained.has(id));
    if (executed.length === 0) continue;
    const retried = [...value.retried].filter((id) => retained.has(id));
    const dKey = dimensionKey(value.dimension);
    const tKey = testKey(value.test);
    if (!dimensionIndexes.has(dKey)) {
      dimensionIndexes.set(dKey, dimensions.length);
      dimensions.push(value.dimension);
    }
    if (!testIndexes.has(tKey)) {
      testIndexes.set(tKey, tests.length);
      tests.push(value.test);
    }
    let executedMask = 0n;
    let retryMask = 0n;
    for (const id of executed) executedMask |= 1n << BigInt(runIndex.get(id));
    for (const id of retried) retryMask |= 1n << BigInt(runIndex.get(id));
    series.push([
      dimensionIndexes.get(dKey),
      testIndexes.get(tKey),
      popcount(executedMask),
      popcount(retryMask),
      executedMask.toString(16),
      retryMask.toString(16),
    ]);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    metric: 'passed-on-retry',
    retentionRuns: MAX_RUNS,
    generatedAt: new Date().toISOString(),
    runs,
    dimensions,
    tests,
    series,
  };
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const history = buildHistory(options);
    const output = `${JSON.stringify(history)}\n`;
    if (Buffer.byteLength(output) > 10 * 1024 * 1024) {
      throw new Error(
        'Generated flake history exceeds the 10 MiB safety limit'
      );
    }
    fs.mkdirSync(path.dirname(options.output), { recursive: true });
    fs.writeFileSync(options.output, output);
    console.log(
      `Wrote ${history.runs.length}-run E2E flake history to ${options.output}`
    );
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

module.exports = { buildHistory, dimensionFor, normalizeFile };
