#!/usr/bin/env node

/**
 * Aggregates E2E test results and benchmark data from CI runs
 * into a unified worlds-status.json for the dashboard.
 *
 * Usage:
 *   node scripts/aggregate-worlds-data.mjs [results-dir] [--output path/to/output.json]
 *
 * Input files expected:
 *   - e2e-results-{world}.json: Vitest JSON output for E2E tests
 *   - bench-results-{app}-{world}.json: Vitest benchmark output
 *   - bench-timings-{app}-{world}.json: Custom timing data
 *
 * Output:
 *   - worlds-status.json: Combined status of all worlds
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.join(__dirname, '..');

// Parse command line arguments
const args = process.argv.slice(2);
let resultsDir = '.';
let outputPath = path.join(rootDir, 'docs/public/data/worlds-status.json');

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--output' && args[i + 1]) {
    outputPath = args[i + 1];
    i++;
  } else if (!args[i].startsWith('--')) {
    resultsDir = args[i];
  }
}

// Load worlds manifest
const manifestPath = path.join(rootDir, 'worlds-manifest.json');
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
} catch (e) {
  console.error(`Error: Could not load worlds manifest: ${e.message}`);
  process.exit(1);
}

// Get all worlds from manifest (now a flat array with type field)
function getAllWorlds() {
  return manifest.worlds || [];
}

// Find all E2E result files
function findE2EResultFiles(dir) {
  const files = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findE2EResultFiles(fullPath));
      } else if (
        entry.name.startsWith('e2e-results-') &&
        entry.name.endsWith('.json')
      ) {
        files.push(fullPath);
      }
    }
  } catch (e) {
    // Directory may not exist
  }
  return files;
}

// Find all benchmark result files
function findBenchmarkFiles(dir) {
  const files = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findBenchmarkFiles(fullPath));
      } else if (
        entry.name.startsWith('bench-timings-') &&
        entry.name.endsWith('.json')
      ) {
        files.push(fullPath);
      }
    }
  } catch (e) {
    // Directory may not exist
  }
  return files;
}

// Parse E2E result file (vitest JSON output)
function parseE2EResults(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

    let total = 0;
    let passed = 0;
    let failed = 0;
    let skipped = 0;
    const tests = [];

    // Vitest JSON format
    for (const file of data.testResults || []) {
      for (const test of file.assertionResults || []) {
        total++;
        const status = test.status;
        if (status === 'passed') passed++;
        else if (status === 'failed') failed++;
        else if (status === 'skipped' || status === 'pending') skipped++;

        tests.push({
          name: test.fullName || test.title,
          status: status === 'pending' ? 'skipped' : status,
          duration: test.duration || 0,
        });
      }
    }

    // Alternative format (direct vitest output)
    if (total === 0 && data.numTotalTests) {
      total = data.numTotalTests;
      passed = data.numPassedTests || 0;
      failed = data.numFailedTests || 0;
      skipped = (data.numPendingTests || 0) + (data.numTodoTests || 0);
    }

    return { total, passed, failed, skipped, tests };
  } catch (e) {
    console.error(
      `Warning: Could not parse E2E results ${filePath}: ${e.message}`
    );
    return null;
  }
}

// Parse benchmark timing file
function parseBenchmarkTimings(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    const metrics = {};

    if (data.summary) {
      for (const [benchName, stats] of Object.entries(data.summary)) {
        metrics[benchName] = {
          mean: stats.avgExecutionTimeMs,
          min: stats.minExecutionTimeMs,
          max: stats.maxExecutionTimeMs,
          samples: stats.samples,
        };

        // Add TTFB for stream benchmarks
        if (stats.avgFirstByteTimeMs !== undefined) {
          metrics[benchName].ttfb = {
            mean: stats.avgFirstByteTimeMs,
            min: stats.minFirstByteTimeMs,
            max: stats.maxFirstByteTimeMs,
          };
        }
      }
    }

    return metrics;
  } catch (e) {
    console.error(
      `Warning: Could not parse benchmark timings ${filePath}: ${e.message}`
    );
    return null;
  }
}

// Extract world ID from filename
function extractWorldFromFilename(filename, prefix) {
  // e2e-results-{world}.json -> world
  // bench-timings-{app}-{world}.json -> world
  const basename = path.basename(filename, '.json');
  const withoutPrefix = basename.replace(prefix, '');

  // For bench files, format is {app}-{world}, we want the last part
  const parts = withoutPrefix.split('-');
  return parts[parts.length - 1];
}

// Aggregate all data
function aggregateWorldsData() {
  const allWorlds = getAllWorlds();
  const timestamp = new Date().toISOString();

  // Initialize worlds status
  const worldsStatus = {};
  for (const world of allWorlds) {
    worldsStatus[world.id] = {
      type: world.type,
      name: world.name,
      package: world.package,
      description: world.description,
      docs: world.docs,
      repository: world.repository,
      e2e: null,
      benchmark: null,
    };
  }

  // Process E2E results
  const e2eFiles = findE2EResultFiles(resultsDir);
  for (const file of e2eFiles) {
    const worldId = extractWorldFromFilename(file, 'e2e-results-');
    if (worldsStatus[worldId]) {
      const results = parseE2EResults(file);
      if (results) {
        const progress =
          results.total > 0
            ? Math.round((results.passed / results.total) * 1000) / 10
            : 0;

        worldsStatus[worldId].e2e = {
          status:
            results.failed === 0
              ? 'passing'
              : results.passed > 0
                ? 'partial'
                : 'failing',
          total: results.total,
          passed: results.passed,
          failed: results.failed,
          skipped: results.skipped,
          progress,
          tests: results.tests,
          lastRun: timestamp,
        };
      }
    }
  }

  // Process benchmark results
  const benchFiles = findBenchmarkFiles(resultsDir);
  const benchmarksByWorld = {};

  for (const file of benchFiles) {
    const worldId = extractWorldFromFilename(file, 'bench-timings-');
    if (!benchmarksByWorld[worldId]) {
      benchmarksByWorld[worldId] = {};
    }

    const metrics = parseBenchmarkTimings(file);
    if (metrics) {
      // Merge metrics (could have multiple apps)
      Object.assign(benchmarksByWorld[worldId], metrics);
    }
  }

  // Assign benchmarks to worlds
  for (const [worldId, metrics] of Object.entries(benchmarksByWorld)) {
    if (worldsStatus[worldId]) {
      worldsStatus[worldId].benchmark = {
        status: Object.keys(metrics).length > 0 ? 'measured' : 'pending',
        metrics,
        lastRun: timestamp,
      };
    }
  }

  return {
    $schema: './worlds-status.schema.json',
    lastUpdated: timestamp,
    commit: process.env.GITHUB_SHA || null,
    branch: process.env.GITHUB_REF_NAME || null,
    worlds: worldsStatus,
  };
}

// Generate test matrix (detailed per-test breakdown)
function generateTestMatrix(worldsStatus) {
  const allTests = new Map(); // testName -> { world -> status }

  // Collect all tests from all worlds
  for (const [worldId, world] of Object.entries(worldsStatus)) {
    if (world.e2e?.tests) {
      for (const test of world.e2e.tests) {
        if (!allTests.has(test.name)) {
          allTests.set(test.name, {});
        }
        allTests.get(test.name)[worldId] = test.status;
      }
    }
  }

  // Convert to array format
  const tests = [];
  for (const [name, results] of allTests) {
    tests.push({ name, results });
  }

  // Sort by test name
  tests.sort((a, b) => a.name.localeCompare(b.name));

  return {
    lastUpdated: new Date().toISOString(),
    tests,
  };
}

// Main
console.log('Aggregating worlds data...');
console.log(`  Results directory: ${resultsDir}`);
console.log(`  Output path: ${outputPath}`);

const status = aggregateWorldsData();
const testMatrix = generateTestMatrix(status.worlds);

// Ensure output directory exists
const outputDir = path.dirname(outputPath);
if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// Write worlds-status.json
fs.writeFileSync(outputPath, JSON.stringify(status, null, 2));
console.log(`\nGenerated ${outputPath}`);

// Write test-matrix.json
const testMatrixPath = path.join(path.dirname(outputPath), 'test-matrix.json');
fs.writeFileSync(testMatrixPath, JSON.stringify(testMatrix, null, 2));
console.log(`Generated ${testMatrixPath}`);

// Summary
const worldCount = Object.keys(status.worlds).length;
const withE2E = Object.values(status.worlds).filter((w) => w.e2e).length;
const withBenchmarks = Object.values(status.worlds).filter(
  (w) => w.benchmark
).length;

console.log(`\nSummary:`);
console.log(`  Total worlds: ${worldCount}`);
console.log(`  With E2E data: ${withE2E}`);
console.log(`  With benchmark data: ${withBenchmarks}`);

for (const [id, world] of Object.entries(status.worlds)) {
  const e2eStatus = world.e2e
    ? `${world.e2e.passed}/${world.e2e.total} (${world.e2e.progress}%)`
    : 'no data';
  const benchStatus = world.benchmark
    ? `${Object.keys(world.benchmark.metrics).length} benchmarks`
    : 'no data';
  console.log(`  - ${world.name}: E2E ${e2eStatus}, Benchmarks ${benchStatus}`);
}
