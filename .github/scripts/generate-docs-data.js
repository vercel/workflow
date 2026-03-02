#!/usr/bin/env node

/**
 * Generates JSON data files for the docs site from CI results.
 * These files are published to GitHub Pages and consumed by the docs.
 *
 * Usage:
 *   node generate-docs-data.js --type e2e --results-dir ./e2e-results --output ./docs-data/e2e-results.json
 *   node generate-docs-data.js --type benchmarks --results-dir ./benchmark-results --output ./docs-data/benchmark-results.json
 */

const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
let type = 'e2e';
let resultsDir = '.';
let outputFile = 'results.json';
let commit = process.env.GITHUB_SHA || null;
let branch = process.env.GITHUB_REF_NAME || 'main';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--type' && args[i + 1]) {
    type = args[i + 1];
    i++;
  } else if (args[i] === '--results-dir' && args[i + 1]) {
    resultsDir = args[i + 1];
    i++;
  } else if (args[i] === '--output' && args[i + 1]) {
    outputFile = args[i + 1];
    i++;
  } else if (args[i] === '--commit' && args[i + 1]) {
    commit = args[i + 1];
    i++;
  } else if (args[i] === '--branch' && args[i + 1]) {
    branch = args[i + 1];
    i++;
  }
}

// World mapping from artifact/file names to world IDs
function extractWorldId(filename, fileType) {
  const base = path.basename(filename, '.json');

  if (fileType === 'e2e') {
    // E2E files: e2e-{category}-{app}.json
    // e2e-vercel-prod-nextjs-turbopack.json → vercel
    // e2e-local-dev-nextjs-turbopack.json → local
    // e2e-local-postgres-nextjs-turbopack.json → postgres
    // e2e-community-turso.json → turso
    if (base.startsWith('e2e-community-')) {
      const rest = base.replace('e2e-community-', '');
      // Remove -dev suffix if present (e2e-community-turso-dev.json)
      return rest.replace(/-dev$/, '');
    }
    if (base.startsWith('e2e-vercel-prod-')) return 'vercel';
    if (base.startsWith('e2e-local-dev-') || base.startsWith('e2e-local-prod-'))
      return 'local';
    if (base.startsWith('e2e-local-postgres-')) return 'postgres';
    if (base.startsWith('e2e-windows-')) return 'local';
    return null;
  }

  if (fileType === 'benchmarks') {
    // Benchmark files: bench-results-{app}-{world}.json
    // bench-results-nextjs-turbopack-local.json → local
    if (base.startsWith('bench-results-')) {
      const parts = base.replace('bench-results-', '').split('-');
      return parts[parts.length - 1];
    }
    // Timing files: bench-timings-{app}-{world}.json
    if (base.startsWith('bench-timings-')) {
      const parts = base.replace('bench-timings-', '').split('-');
      return parts[parts.length - 1];
    }
    return null;
  }

  return null;
}

// Find all result files recursively
function findResultFiles(dir, prefix) {
  const files = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findResultFiles(fullPath, prefix));
      } else if (
        entry.name.startsWith(prefix) &&
        entry.name.endsWith('.json')
      ) {
        files.push(fullPath);
      }
    }
  } catch (e) {
    // Directory doesn't exist
  }
  return files;
}

// Parse vitest E2E results
function parseE2EResults(files) {
  const worldResults = {};

  for (const file of files) {
    const worldId = extractWorldId(file, 'e2e');
    if (!worldId) continue;

    try {
      const content = JSON.parse(fs.readFileSync(file, 'utf-8'));

      // Initialize world if needed
      if (!worldResults[worldId]) {
        worldResults[worldId] = {
          status: 'pending',
          total: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          frameworks: {},
        };
      }

      // Parse vitest JSON format
      if (content.testResults) {
        for (const testFile of content.testResults) {
          for (const assertion of testFile.assertionResults || []) {
            worldResults[worldId].total++;
            if (assertion.status === 'passed') {
              worldResults[worldId].passed++;
            } else if (assertion.status === 'failed') {
              worldResults[worldId].failed++;
            } else {
              worldResults[worldId].skipped++;
            }
          }
        }
      }

      // Extract framework from filename for detailed breakdown
      const basename = path.basename(file, '.json');
      const frameworkMatch = basename.match(
        /-(nextjs-turbopack|nextjs-webpack|nitro|nuxt|sveltekit|vite|hono|express|fastify|astro)(?:-(canary|stable))?$/
      );
      if (frameworkMatch) {
        const framework = frameworkMatch[1];
        if (!worldResults[worldId].frameworks[framework]) {
          worldResults[worldId].frameworks[framework] = {
            total: 0,
            passed: 0,
            failed: 0,
          };
        }
        if (content.testResults) {
          for (const testFile of content.testResults) {
            for (const assertion of testFile.assertionResults || []) {
              worldResults[worldId].frameworks[framework].total++;
              if (assertion.status === 'passed') {
                worldResults[worldId].frameworks[framework].passed++;
              } else if (assertion.status === 'failed') {
                worldResults[worldId].frameworks[framework].failed++;
              }
            }
          }
        }
      }
    } catch (e) {
      console.error(`Warning: Could not parse ${file}: ${e.message}`);
    }
  }

  // Calculate status for each world
  for (const [worldId, results] of Object.entries(worldResults)) {
    if (results.total === 0) {
      results.status = 'pending';
    } else if (results.failed > 0) {
      results.status = results.passed > 0 ? 'partial' : 'failing';
    } else {
      results.status = 'passing';
    }
    results.progress =
      results.total > 0
        ? Math.round((results.passed / results.total) * 100)
        : 0;
  }

  return worldResults;
}

// Parse benchmark results
function parseBenchmarkResults(files) {
  const worldResults = {};

  // Group files by world
  const filesByWorld = {};
  for (const file of files) {
    const worldId = extractWorldId(file, 'benchmarks');
    if (!worldId) continue;
    if (!filesByWorld[worldId]) {
      filesByWorld[worldId] = { results: [], timings: [] };
    }
    if (path.basename(file).startsWith('bench-results-')) {
      filesByWorld[worldId].results.push(file);
    } else if (path.basename(file).startsWith('bench-timings-')) {
      filesByWorld[worldId].timings.push(file);
    }
  }

  for (const [worldId, worldFiles] of Object.entries(filesByWorld)) {
    worldResults[worldId] = {
      status: 'pending',
      metrics: {},
      frameworks: {},
    };

    // Parse benchmark results
    for (const file of worldFiles.results) {
      try {
        const content = JSON.parse(fs.readFileSync(file, 'utf-8'));

        // Extract framework from filename
        const basename = path.basename(file, '.json');
        const match = basename.match(/bench-results-(.+)-\w+$/);
        const framework = match ? match[1] : 'unknown';

        if (!worldResults[worldId].frameworks[framework]) {
          worldResults[worldId].frameworks[framework] = {};
        }

        // Parse vitest bench format
        for (const fileData of content.files || []) {
          for (const group of fileData.groups || []) {
            for (const bench of group.benchmarks || []) {
              if (bench.mean !== undefined && bench.mean !== null) {
                const metric = {
                  mean: bench.mean,
                  min: bench.min,
                  max: bench.max,
                  samples: bench.sampleCount,
                };
                worldResults[worldId].metrics[bench.name] = metric;
                worldResults[worldId].frameworks[framework][bench.name] =
                  metric;
              }
            }
          }
        }
      } catch (e) {
        console.error(`Warning: Could not parse ${file}: ${e.message}`);
      }
    }

    // Parse timing data for workflow execution times
    for (const file of worldFiles.timings) {
      try {
        const content = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (content.summary) {
          for (const [benchName, timing] of Object.entries(content.summary)) {
            if (worldResults[worldId].metrics[benchName]) {
              // Store workflow time metrics separately from wall time
              if (timing.avgExecutionTimeMs !== undefined) {
                worldResults[worldId].metrics[benchName].workflowTime =
                  timing.avgExecutionTimeMs;
              }
              if (timing.minExecutionTimeMs !== undefined) {
                worldResults[worldId].metrics[benchName].workflowMin =
                  timing.minExecutionTimeMs;
              }
              if (timing.maxExecutionTimeMs !== undefined) {
                worldResults[worldId].metrics[benchName].workflowMax =
                  timing.maxExecutionTimeMs;
              }
              if (timing.avgFirstByteTimeMs !== undefined) {
                worldResults[worldId].metrics[benchName].ttfb =
                  timing.avgFirstByteTimeMs;
              }
              if (timing.avgSlurpTimeMs !== undefined) {
                worldResults[worldId].metrics[benchName].slurp =
                  timing.avgSlurpTimeMs;
              }
            }
          }
        }
      } catch (e) {
        console.error(`Warning: Could not parse ${file}: ${e.message}`);
      }
    }

    // Set status
    worldResults[worldId].status =
      Object.keys(worldResults[worldId].metrics).length > 0
        ? 'measured'
        : 'pending';
  }

  return worldResults;
}

// Main
const prefix = type === 'e2e' ? 'e2e-' : 'bench-';
const resultFiles = findResultFiles(resultsDir, prefix);

if (resultFiles.length === 0) {
  console.log(`No ${type} result files found in ${resultsDir}`);
  // Write empty results
  const emptyOutput = {
    lastUpdated: new Date().toISOString(),
    commit,
    branch,
    type,
    worlds: {},
  };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, JSON.stringify(emptyOutput, null, 2));
  console.log(`Wrote empty results to ${outputFile}`);
  process.exit(0);
}

console.log(`Found ${resultFiles.length} ${type} result files`);

const worldResults =
  type === 'e2e'
    ? parseE2EResults(resultFiles)
    : parseBenchmarkResults(resultFiles);

const output = {
  lastUpdated: new Date().toISOString(),
  commit,
  branch,
  type,
  worlds: worldResults,
};

// Ensure output directory exists
fs.mkdirSync(path.dirname(outputFile), { recursive: true });
fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));
console.log(`Wrote ${type} results to ${outputFile}`);
console.log(`Worlds with data: ${Object.keys(worldResults).join(', ')}`);
