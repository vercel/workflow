#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Parse arguments: render.js <benchmark-file> <app-name> <backend> [--baseline <baseline-file>]
const args = process.argv.slice(2);
let benchmarkFile = null;
let appName = null;
let backend = null;
let baselineFile = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--baseline' && args[i + 1]) {
    baselineFile = args[i + 1];
    i++;
  } else if (!benchmarkFile) {
    benchmarkFile = args[i];
  } else if (!appName) {
    appName = args[i];
  } else if (!backend) {
    backend = args[i];
  }
}

if (!benchmarkFile || !appName || !backend) {
  console.error(
    'Usage: render.js <benchmark-file> <app-name> <backend> [--baseline <baseline-file>]'
  );
  process.exit(1);
}

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

// Try to load baseline data
let baselineData = null;
let baselineTimings = null;
if (baselineFile && fs.existsSync(baselineFile)) {
  try {
    baselineData = JSON.parse(fs.readFileSync(baselineFile, 'utf-8'));
    // Also try to load baseline timings
    const baselineTimingFile = path.join(
      path.dirname(baselineFile),
      path.basename(baselineFile).replace('bench-results-', 'bench-timings-')
    );
    if (fs.existsSync(baselineTimingFile)) {
      baselineTimings = JSON.parse(
        fs.readFileSync(baselineTimingFile, 'utf-8')
      );
    }
  } catch (e) {
    console.error(`Warning: Could not parse baseline file: ${e.message}`);
  }
}

// Build baseline lookup map: benchName -> { wallTime, workflowTime, ttfb }
const baselineLookup = {};
if (baselineData) {
  for (const file of baselineData.files || []) {
    for (const group of file.groups || []) {
      for (const bench of group.benchmarks || []) {
        if (bench.mean !== undefined && bench.mean !== null) {
          baselineLookup[bench.name] = {
            wallTime: bench.mean,
            workflowTime:
              baselineTimings?.summary?.[bench.name]?.avgExecutionTimeMs ??
              null,
            ttfb:
              baselineTimings?.summary?.[bench.name]?.avgFirstByteTimeMs ??
              null,
          };
        }
      }
    }
  }
}

// Format number with consistent width
function formatSec(ms, decimals = 3) {
  return (ms / 1000).toFixed(decimals);
}

// Format delta between current and baseline values
function formatDelta(current, baseline) {
  if (
    baseline === null ||
    baseline === undefined ||
    current === null ||
    current === undefined
  ) {
    return '';
  }
  const percentChange = ((current - baseline) / baseline) * 100;
  if (Math.abs(percentChange) < 0.5) {
    return ' (~)';
  }
  const sign = percentChange > 0 ? '+' : '';
  const emoji = percentChange > 5 ? ' 🔺' : percentChange < -5 ? ' 🟢' : '';
  return ` (${sign}${percentChange.toFixed(1)}%${emoji})`;
}

// Get world emoji
function getWorldEmoji(world) {
  switch (world) {
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

  const emoji = getWorldEmoji(backend);
  console.log(`## ${emoji} Benchmark Results: ${appName} (${backend} world)\n`);

  // Show baseline comparison note if baseline data is available
  if (Object.keys(baselineLookup).length > 0) {
    console.log(
      '> 📈 _Comparing against baseline from `main` branch. Green 🟢 = faster, Red 🔺 = slower._\n'
    );
  }

  for (const file of data.files) {
    for (const group of file.groups) {
      // Separate regular and stream benchmarks
      const regularBenchmarks = [];
      const streamBenchmarks = [];

      for (const bench of group.benchmarks) {
        const summary = workflowTimings?.summary?.[bench.name];
        if (summary?.avgFirstByteTimeMs !== undefined) {
          streamBenchmarks.push(bench);
        } else {
          regularBenchmarks.push(bench);
        }
      }

      // Render regular benchmarks
      if (regularBenchmarks.length > 0) {
        console.log(
          '| Benchmark | Workflow Time (avg) | Min | Max | Wall Time | Overhead | Samples |'
        );
        console.log(
          '|:----------|--------------------:|----:|----:|----------:|---------:|--------:|'
        );

        for (const bench of regularBenchmarks) {
          // Skip benchmarks without valid timing data (failed or timed out)
          if (bench.mean === undefined || bench.mean === null) {
            console.log(`| ${bench.name} | ⚠️ No data | - | - | - | - | 0 |`);
            continue;
          }

          const baseline = baselineLookup[bench.name];
          const wallTimeSec = formatSec(bench.mean);
          const wallDelta = formatDelta(bench.mean, baseline?.wallTime);
          let workflowTimeSec = '-';
          let workflowDelta = '';
          let minTimeSec = '-';
          let maxTimeSec = '-';
          let overheadSec = '-';

          if (workflowTimings?.summary?.[bench.name]) {
            const summary = workflowTimings.summary[bench.name];
            workflowTimeSec = formatSec(summary.avgExecutionTimeMs);
            workflowDelta = formatDelta(
              summary.avgExecutionTimeMs,
              baseline?.workflowTime
            );
            if (summary.minExecutionTimeMs !== undefined) {
              minTimeSec = formatSec(summary.minExecutionTimeMs);
            }
            if (summary.maxExecutionTimeMs !== undefined) {
              maxTimeSec = formatSec(summary.maxExecutionTimeMs);
            }
            const overheadMs = bench.mean - summary.avgExecutionTimeMs;
            overheadSec = formatSec(overheadMs);
          }

          console.log(
            `| ${bench.name} | ${workflowTimeSec}s${workflowDelta} | ${minTimeSec}s | ${maxTimeSec}s | ${wallTimeSec}s${wallDelta} | ${overheadSec}s | ${bench.sampleCount} |`
          );
        }
        console.log('');
      }

      // Render stream benchmarks with TTFB column
      if (streamBenchmarks.length > 0) {
        console.log('**Stream Benchmarks**\n');
        console.log(
          '| Benchmark | Workflow Time (avg) | TTFB | Min | Max | Wall Time | Overhead | Samples |'
        );
        console.log(
          '|:----------|--------------------:|-----:|----:|----:|----------:|---------:|--------:|'
        );

        for (const bench of streamBenchmarks) {
          // Skip benchmarks without valid timing data (failed or timed out)
          if (bench.mean === undefined || bench.mean === null) {
            console.log(
              `| ${bench.name} | ⚠️ No data | - | - | - | - | - | 0 |`
            );
            continue;
          }

          const baseline = baselineLookup[bench.name];
          const wallTimeSec = formatSec(bench.mean);
          const wallDelta = formatDelta(bench.mean, baseline?.wallTime);
          let workflowTimeSec = '-';
          let workflowDelta = '';
          let minTimeSec = '-';
          let maxTimeSec = '-';
          let overheadSec = '-';
          let ttfbSec = '-';
          let ttfbDelta = '';

          if (workflowTimings?.summary?.[bench.name]) {
            const summary = workflowTimings.summary[bench.name];
            workflowTimeSec = formatSec(summary.avgExecutionTimeMs);
            workflowDelta = formatDelta(
              summary.avgExecutionTimeMs,
              baseline?.workflowTime
            );
            if (summary.minExecutionTimeMs !== undefined) {
              minTimeSec = formatSec(summary.minExecutionTimeMs);
            }
            if (summary.maxExecutionTimeMs !== undefined) {
              maxTimeSec = formatSec(summary.maxExecutionTimeMs);
            }
            if (summary.avgFirstByteTimeMs !== undefined) {
              ttfbSec = formatSec(summary.avgFirstByteTimeMs);
              ttfbDelta = formatDelta(
                summary.avgFirstByteTimeMs,
                baseline?.ttfb
              );
            }
            const overheadMs = bench.mean - summary.avgExecutionTimeMs;
            overheadSec = formatSec(overheadMs);
          }

          console.log(
            `| ${bench.name} | ${workflowTimeSec}s${workflowDelta} | ${ttfbSec}s${ttfbDelta} | ${minTimeSec}s | ${maxTimeSec}s | ${wallTimeSec}s${wallDelta} | ${overheadSec}s | ${bench.sampleCount} |`
          );
        }
        console.log('');
      }
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
