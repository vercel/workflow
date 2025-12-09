#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
let resultsDir = '.';
let jobName = 'E2E Tests';
let mode = 'single'; // 'single' for step summary, 'aggregate' for PR comment
let runUrl = '';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--job-name' && args[i + 1]) {
    jobName = args[i + 1];
    i++;
  } else if (args[i] === '--mode' && args[i + 1]) {
    mode = args[i + 1];
    i++;
  } else if (args[i] === '--run-url' && args[i + 1]) {
    runUrl = args[i + 1];
    i++;
  } else if (!args[i].startsWith('--')) {
    resultsDir = args[i];
  }
}

// Find all e2e result JSON files
function findResultFiles(dir) {
  const files = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findResultFiles(fullPath));
      } else if (
        entry.name.startsWith('e2e-') &&
        !entry.name.startsWith('e2e-metadata-') &&
        entry.name.endsWith('.json')
      ) {
        files.push(fullPath);
      }
    }
  } catch (e) {
    // Directory doesn't exist or can't be read
  }
  return files;
}

// Find all e2e metadata JSON files
function findMetadataFiles(dir) {
  const files = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...findMetadataFiles(fullPath));
      } else if (
        entry.name.startsWith('e2e-metadata-') &&
        entry.name.endsWith('.json')
      ) {
        files.push(fullPath);
      }
    }
  } catch (e) {
    // Directory doesn't exist or can't be read
  }
  return files;
}

// Load metadata indexed by app name
function loadMetadata(dir) {
  const metadata = new Map(); // app -> { runIds, vercel }
  const metadataFiles = findMetadataFiles(dir);

  for (const file of metadataFiles) {
    try {
      const content = JSON.parse(fs.readFileSync(file, 'utf-8'));
      // Extract app name from filename: e2e-metadata-{app}-vercel.json
      const basename = path.basename(file, '.json');
      const match = basename.match(/^e2e-metadata-(.+)-vercel$/);
      if (match && content.vercel) {
        const appName = match[1];
        metadata.set(appName, content);
      }
    } catch (e) {
      // Skip invalid metadata files
    }
  }

  return metadata;
}

// Generate observability URL for a test
function getObservabilityUrl(metadata, appName, testName) {
  const appMetadata = metadata.get(appName);
  if (!appMetadata || !appMetadata.vercel) return null;

  const { vercel, runIds } = appMetadata;
  if (!vercel.teamSlug || !vercel.projectSlug) return null;

  // Find the runId for this test
  const runInfo = runIds?.find((r) => r.testName === testName);
  if (!runInfo) return null;

  const env = vercel.environment === 'production' ? 'production' : 'preview';
  return `https://vercel.com/${vercel.teamSlug}/${vercel.projectSlug}/observability/workflows/runs/${runInfo.runId}?environment=${env}`;
}

// Parse vitest JSON output
function parseVitestResults(file) {
  try {
    const content = JSON.parse(fs.readFileSync(file, 'utf-8'));
    const results = {
      file: path.basename(file),
      passed: 0,
      failed: 0,
      skipped: 0,
      duration: 0,
      failedTests: [],
    };

    // Handle vitest JSON reporter format
    if (content.testResults) {
      for (const testFile of content.testResults) {
        results.duration += testFile.duration || 0;
        for (const assertionResult of testFile.assertionResults || []) {
          if (assertionResult.status === 'passed') {
            results.passed++;
          } else if (assertionResult.status === 'failed') {
            results.failed++;
            results.failedTests.push({
              name: assertionResult.fullName || assertionResult.title,
              file: testFile.name,
              message:
                assertionResult.failureMessages?.join('\n').slice(0, 200) || '',
            });
          } else if (assertionResult.status === 'skipped') {
            results.skipped++;
          }
        }
      }
    }

    return results;
  } catch (e) {
    console.error(`Warning: Could not parse ${file}: ${e.message}`);
    return null;
  }
}

// Parse job info from filename (e.g., e2e-local-dev-nextjs-turbopack.json)
function parseJobInfo(filename) {
  // Pattern: e2e-{category}-{app}.json or e2e-{category}-{subcategory}-{app}.json
  const base = path.basename(filename, '.json');
  const parts = base.split('-');

  if (parts.length >= 3) {
    // e2e-vercel-prod-nextjs-turbopack -> category: vercel-prod, app: nextjs-turbopack
    // e2e-local-dev-nextjs-turbopack -> category: local-dev, app: nextjs-turbopack
    // e2e-community-turso -> category: community, app: turso
    const categoryEndIndex = parts.findIndex(
      (p, i) =>
        i > 1 &&
        [
          'nextjs',
          'nitro',
          'vite',
          'nuxt',
          'sveltekit',
          'hono',
          'express',
          'fastify',
          'astro',
          'example',
          'turso',
          'mongodb',
          'redis',
          'starter',
        ].some((app) => p.startsWith(app))
    );

    if (categoryEndIndex > 1) {
      return {
        category: parts.slice(1, categoryEndIndex).join('-'),
        app: parts.slice(categoryEndIndex).join('-'),
      };
    }
  }

  return {
    category: 'other',
    app: base,
  };
}

// Aggregate all results
function aggregateResults(files) {
  const summary = {
    totalPassed: 0,
    totalFailed: 0,
    totalSkipped: 0,
    totalDuration: 0,
    fileResults: [],
    allFailedTests: [],
  };

  for (const file of files) {
    const results = parseVitestResults(file);
    if (results) {
      summary.totalPassed += results.passed;
      summary.totalFailed += results.failed;
      summary.totalSkipped += results.skipped;
      summary.totalDuration += results.duration;
      summary.fileResults.push(results);
      summary.allFailedTests.push(...results.failedTests);
    }
  }

  return summary;
}

// Aggregate results grouped by job category
function aggregateByCategory(files) {
  const categories = new Map();
  const overallSummary = {
    totalPassed: 0,
    totalFailed: 0,
    totalSkipped: 0,
    allFailedTests: [],
  };

  for (const file of files) {
    const { category, app } = parseJobInfo(file);
    const results = parseVitestResults(file);

    if (!results) continue;

    if (!categories.has(category)) {
      categories.set(category, {
        name: category,
        passed: 0,
        failed: 0,
        skipped: 0,
        apps: [],
        failedTests: [],
      });
    }

    const cat = categories.get(category);
    cat.passed += results.passed;
    cat.failed += results.failed;
    cat.skipped += results.skipped;
    cat.apps.push({
      name: app,
      passed: results.passed,
      failed: results.failed,
      skipped: results.skipped,
    });
    cat.failedTests.push(
      ...results.failedTests.map((t) => ({ ...t, app, category }))
    );

    overallSummary.totalPassed += results.passed;
    overallSummary.totalFailed += results.failed;
    overallSummary.totalSkipped += results.skipped;
    overallSummary.allFailedTests.push(
      ...results.failedTests.map((t) => ({ ...t, app, category }))
    );
  }

  return { categories, overallSummary };
}

// Render markdown summary for single job (step summary)
function renderSingleJobSummary(summary) {
  const total =
    summary.totalPassed + summary.totalFailed + summary.totalSkipped;
  const statusEmoji = summary.totalFailed > 0 ? '❌' : '✅';
  const statusText =
    summary.totalFailed > 0 ? 'Some tests failed' : 'All tests passed';

  console.log(`## ${statusEmoji} ${jobName}\n`);
  console.log(`**Status:** ${statusText}\n`);

  // Summary table
  console.log('| Metric | Count |');
  console.log('|:-------|------:|');
  console.log(`| ✅ Passed | ${summary.totalPassed} |`);
  console.log(`| ❌ Failed | ${summary.totalFailed} |`);
  console.log(`| ⏭️ Skipped | ${summary.totalSkipped} |`);
  console.log(`| **Total** | **${total}** |`);
  console.log('');

  // Duration
  const durationSec = (summary.totalDuration / 1000).toFixed(2);
  console.log(`_Duration: ${durationSec}s_\n`);

  // Failed tests details
  if (summary.allFailedTests.length > 0) {
    console.log('### Failed Tests\n');
    for (const test of summary.allFailedTests) {
      console.log(`<details>`);
      console.log(`<summary>❌ ${test.name}</summary>\n`);
      console.log(`**File:** \`${test.file}\`\n`);
      if (test.message) {
        console.log('```');
        console.log(test.message);
        console.log('```');
      }
      console.log('</details>\n');
    }
  }

  // Results by file
  if (summary.fileResults.length > 1) {
    console.log('<details>');
    console.log('<summary>Results by File</summary>\n');
    console.log('| File | Passed | Failed | Skipped |');
    console.log('|:-----|-------:|-------:|--------:|');
    for (const result of summary.fileResults) {
      const fileStatus = result.failed > 0 ? '❌' : '✅';
      console.log(
        `| ${fileStatus} ${result.file} | ${result.passed} | ${result.failed} | ${result.skipped} |`
      );
    }
    console.log('</details>');
  }
}

// Category display names
const categoryNames = {
  'vercel-prod': '▲ Vercel Production',
  'local-dev': '💻 Local Development',
  'local-prod': '📦 Local Production',
  'local-postgres': '🐘 Local Postgres',
  windows: '🪟 Windows',
  community: '🌍 Community Worlds',
  other: '📋 Other',
};

// Category order for display
const categoryOrder = [
  'vercel-prod',
  'local-dev',
  'local-prod',
  'local-postgres',
  'windows',
  'community',
  'other',
];

// Render aggregated PR comment summary
function renderAggregatedSummary(categories, overallSummary, metadata) {
  const total =
    overallSummary.totalPassed +
    overallSummary.totalFailed +
    overallSummary.totalSkipped;
  const statusEmoji = overallSummary.totalFailed > 0 ? '❌' : '✅';
  const statusText =
    overallSummary.totalFailed > 0 ? 'Some tests failed' : 'All tests passed';

  console.log('<!-- e2e-test-results -->');
  console.log(`## 🧪 E2E Test Results\n`);
  console.log(`${statusEmoji} **${statusText}**\n`);

  // Overall summary table
  console.log('### Summary\n');
  console.log('| | Passed | Failed | Skipped | Total |');
  console.log('|:--|------:|-------:|--------:|------:|');

  // Sort categories by defined order
  const sortedCategories = Array.from(categories.entries()).sort(
    ([a], [b]) =>
      (categoryOrder.indexOf(a) === -1 ? 999 : categoryOrder.indexOf(a)) -
      (categoryOrder.indexOf(b) === -1 ? 999 : categoryOrder.indexOf(b))
  );

  for (const [catName, cat] of sortedCategories) {
    const catTotal = cat.passed + cat.failed + cat.skipped;
    const catStatus = cat.failed > 0 ? '❌' : '✅';
    const displayName = categoryNames[catName] || catName;
    console.log(
      `| ${catStatus} ${displayName} | ${cat.passed} | ${cat.failed} | ${cat.skipped} | ${catTotal} |`
    );
  }

  console.log(
    `| **Total** | **${overallSummary.totalPassed}** | **${overallSummary.totalFailed}** | **${overallSummary.totalSkipped}** | **${total}** |`
  );
  console.log('');

  // Failed tests section - grouped by category and app
  if (overallSummary.allFailedTests.length > 0) {
    console.log('### ❌ Failed Tests\n');

    // Group failed tests by category, then by app
    const failedByCategory = new Map();
    for (const test of overallSummary.allFailedTests) {
      if (!failedByCategory.has(test.category)) {
        failedByCategory.set(test.category, new Map());
      }
      const catMap = failedByCategory.get(test.category);
      if (!catMap.has(test.app)) {
        catMap.set(test.app, []);
      }
      catMap.get(test.app).push(test);
    }

    // Sort categories by defined order
    const sortedFailedCategories = Array.from(failedByCategory.entries()).sort(
      ([a], [b]) =>
        (categoryOrder.indexOf(a) === -1 ? 999 : categoryOrder.indexOf(a)) -
        (categoryOrder.indexOf(b) === -1 ? 999 : categoryOrder.indexOf(b))
    );

    for (const [catName, appsMap] of sortedFailedCategories) {
      const catDisplay = categoryNames[catName] || catName;
      const catFailedCount = Array.from(appsMap.values()).reduce(
        (sum, tests) => sum + tests.length,
        0
      );

      console.log(`<details>`);
      console.log(
        `<summary>${catDisplay} (${catFailedCount} failed)</summary>\n`
      );

      for (const [appName, tests] of appsMap.entries()) {
        console.log(`**${appName}** (${tests.length} failed):\n`);
        for (const test of tests) {
          // Extract just the test name without "e2e " prefix if present
          const testName = test.name.replace(/^e2e\s+/, '');
          // Add observability link for vercel-prod tests
          if (catName === 'vercel-prod') {
            const obsUrl = getObservabilityUrl(metadata, appName, test.name);
            if (obsUrl) {
              console.log(`- \`${testName}\` ([🔍 observability](${obsUrl}))`);
            } else {
              console.log(`- \`${testName}\``);
            }
          } else {
            console.log(`- \`${testName}\``);
          }
        }
        console.log('');
      }

      console.log('</details>\n');
    }
  }

  // Detailed breakdown by category
  console.log('### Details by Category\n');

  for (const [catName, cat] of sortedCategories) {
    const catStatus = cat.failed > 0 ? '❌' : '✅';
    const displayName = categoryNames[catName] || catName;

    console.log(`<details>`);
    console.log(`<summary>${catStatus} ${displayName}</summary>\n`);
    console.log('| App | Passed | Failed | Skipped |');
    console.log('|:----|-------:|-------:|--------:|');
    for (const app of cat.apps) {
      const appStatus = app.failed > 0 ? '❌' : '✅';
      console.log(
        `| ${appStatus} ${app.name} | ${app.passed} | ${app.failed} | ${app.skipped} |`
      );
    }
    console.log('</details>\n');
  }

  // Add link to workflow run
  if (runUrl) {
    console.log('---');
    console.log(`📋 [View full workflow run](${runUrl})`);
  }
}

// Main
const resultFiles = findResultFiles(resultsDir);

if (resultFiles.length === 0) {
  // No results found, output a simple message
  if (mode === 'aggregate') {
    console.log('<!-- e2e-test-results -->');
    console.log('## 🧪 E2E Test Results\n');
    console.log('_No test result files found._\n');
  } else {
    console.log(`## ${jobName}\n`);
    console.log('_No test result files found._\n');
  }
  process.exit(0);
}

if (mode === 'aggregate') {
  const { categories, overallSummary } = aggregateByCategory(resultFiles);
  const metadata = loadMetadata(resultsDir);
  renderAggregatedSummary(categories, overallSummary, metadata);

  // Exit with non-zero if any tests failed
  if (overallSummary.totalFailed > 0) {
    process.exit(1);
  }
} else {
  const summary = aggregateResults(resultFiles);
  renderSingleJobSummary(summary);

  // Exit with non-zero if any tests failed
  if (summary.totalFailed > 0) {
    process.exit(1);
  }
}
