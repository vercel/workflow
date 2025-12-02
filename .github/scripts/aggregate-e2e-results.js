#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
let resultsDir = '.';
let jobName = 'E2E Tests';

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--job-name' && args[i + 1]) {
    jobName = args[i + 1];
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

// Render markdown summary
function renderSummary(summary) {
  const total =
    summary.totalPassed + summary.totalFailed + summary.totalSkipped;
  const statusEmoji =
    summary.totalFailed > 0 ? '❌' : summary.totalSkipped > 0 ? '⚠️' : '✅';
  const statusText =
    summary.totalFailed > 0
      ? 'Some tests failed'
      : summary.totalSkipped > 0
        ? 'All tests passed (some skipped)'
        : 'All tests passed';

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
      const fileStatus =
        result.failed > 0 ? '❌' : result.skipped > 0 ? '⚠️' : '✅';
      console.log(
        `| ${fileStatus} ${result.file} | ${result.passed} | ${result.failed} | ${result.skipped} |`
      );
    }
    console.log('</details>');
  }
}

// Main
const resultFiles = findResultFiles(resultsDir);

if (resultFiles.length === 0) {
  // No results found, output a simple message
  console.log(`## ${jobName}\n`);
  console.log('_No test result files found._\n');
  process.exit(0);
}

const summary = aggregateResults(resultFiles);
renderSummary(summary);

// Exit with non-zero if any tests failed
if (summary.totalFailed > 0) {
  process.exit(1);
}
