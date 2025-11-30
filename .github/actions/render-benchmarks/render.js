#!/usr/bin/env node

const fs = require('fs');

const [, , benchmarkFile, appName, backend] = process.argv;

if (!benchmarkFile || !appName || !backend) {
  console.error('Usage: render.js <benchmark-file> <app-name> <backend>');
  process.exit(1);
}

const path = require('path');

// Try to load workflow timing data
let workflowTimings = null;
// Only replace filename, not directory name
const timingFilename = path
  .basename(benchmarkFile)
  .replace('bench-results-', 'bench-timings-');
const timingFile = path.join(path.dirname(benchmarkFile), timingFilename);
if (fs.existsSync(timingFile)) {
  try {
    workflowTimings = JSON.parse(fs.readFileSync(timingFile, 'utf-8'));
  } catch (e) {
    console.error(
      `Warning: Could not parse timing file ${timingFile}: ${e.message}`
    );
  }
}

// Format number with consistent width
function formatSec(ms, decimals = 3) {
  return (ms / 1000).toFixed(decimals);
}

// Get backend emoji
function getBackendEmoji(backend) {
  switch (backend) {
    case 'vercel':
      return '▲';
    case 'postgres':
      return '🐘';
    case 'local':
      return '💻';
    default:
      return '';
  }
}

try {
  const data = JSON.parse(fs.readFileSync(benchmarkFile, 'utf-8'));

  const emoji = getBackendEmoji(backend);
  console.log(`## ${emoji} Benchmark Results: ${appName} (${backend})\n`);

  for (const file of data.files) {
    for (const group of file.groups) {
      // Workflow Time is primary metric, Wall Time is secondary
      console.log(
        '| Benchmark | Workflow Time (avg) | Min | Max | Wall Time | Overhead | Samples |'
      );
      console.log(
        '|:----------|--------------------:|----:|----:|----------:|---------:|--------:|'
      );

      for (const bench of group.benchmarks) {
        // Skip benchmarks without valid timing data (failed or timed out)
        if (bench.mean === undefined || bench.mean === null) {
          console.log(`| ${bench.name} | ⚠️ No data | - | - | - | - | 0 |`);
          continue;
        }

        const wallTimeSec = formatSec(bench.mean);

        // Get workflow execution time if available
        let workflowTimeSec = '-';
        let minTimeSec = '-';
        let maxTimeSec = '-';
        let overheadSec = '-';

        let firstByteSec = null;

        if (workflowTimings?.summary?.[bench.name]) {
          const summary = workflowTimings.summary[bench.name];
          workflowTimeSec = formatSec(summary.avgExecutionTimeMs);

          // Get min/max if available
          if (summary.minExecutionTimeMs !== undefined) {
            minTimeSec = formatSec(summary.minExecutionTimeMs);
          }
          if (summary.maxExecutionTimeMs !== undefined) {
            maxTimeSec = formatSec(summary.maxExecutionTimeMs);
          }

          // Get first byte time if available (for stream benchmarks)
          if (summary.avgFirstByteTimeMs !== undefined) {
            firstByteSec = formatSec(summary.avgFirstByteTimeMs);
          }

          // Calculate overhead (wall time - workflow time)
          const overheadMs = bench.mean - summary.avgExecutionTimeMs;
          overheadSec = formatSec(overheadMs);
        }

        // Add TTFB annotation for stream benchmarks
        const ttfbAnnotation =
          firstByteSec !== null ? ` (TTFB: ${firstByteSec}s)` : '';
        console.log(
          `| ${bench.name}${ttfbAnnotation} | ${workflowTimeSec}s | ${minTimeSec}s | ${maxTimeSec}s | ${wallTimeSec}s | ${overheadSec}s | ${bench.sampleCount} |`
        );
      }
      console.log('');
    }
  }

  // Add legend
  console.log('<details>');
  console.log('<summary>Column Definitions</summary>\n');
  console.log(
    '- **Workflow Time (avg)**: Average runtime reported by workflow (completedAt - createdAt)'
  );
  console.log('- **Min**: Minimum workflow execution time across all samples');
  console.log('- **Max**: Maximum workflow execution time across all samples');
  console.log(
    '- **Wall Time**: Total testbench time (trigger workflow + poll for result)'
  );
  console.log('- **Overhead**: Testbench overhead (Wall Time - Workflow Time)');
  console.log('- **Samples**: Number of benchmark iterations run');
  console.log(
    '- **TTFB**: Time to First Byte - time from workflow start until first stream byte received (stream benchmarks only)'
  );
  console.log('</details>');
} catch (error) {
  console.error(`Error rendering benchmark results: ${error.message}`);
  process.exit(1);
}
