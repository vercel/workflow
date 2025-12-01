#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const [, , resultsDir = '.'] = process.argv;

// Backend display config
const backendConfig = {
  local: { emoji: '💻', label: 'Local' },
  postgres: { emoji: '🐘', label: 'Postgres' },
  vercel: { emoji: '▲', label: 'Vercel' },
};

// Framework display config
const frameworkConfig = {
  'nextjs-turbopack': { label: 'Next.js (Turbopack)' },
  nitro: { label: 'Nitro' },
  express: { label: 'Express' },
};

// Format milliseconds as seconds
function formatSec(ms, decimals = 3) {
  return (ms / 1000).toFixed(decimals);
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
        entry.name.startsWith('bench-results-') &&
        entry.name.endsWith('.json')
      ) {
        files.push(fullPath);
      }
    }
  } catch (e) {
    console.error(`Warning: Could not read directory ${dir}: ${e.message}`);
  }
  return files;
}

// Parse filename to extract app and backend
function parseFilename(filename) {
  // Format: bench-results-{app}-{backend}.json
  const match = filename.match(/bench-results-(.+)-(\w+)\.json$/);
  if (!match) return null;
  return { app: match[1], backend: match[2] };
}

// Load timing data for a benchmark file
function loadTimingData(benchmarkFile) {
  // Only replace filename, not directory name
  const timingFilename = path
    .basename(benchmarkFile)
    .replace('bench-results-', 'bench-timings-');
  const timingFile = path.join(path.dirname(benchmarkFile), timingFilename);
  if (fs.existsSync(timingFile)) {
    try {
      return JSON.parse(fs.readFileSync(timingFile, 'utf-8'));
    } catch (e) {
      console.error(
        `Warning: Could not parse timing file ${timingFile}: ${e.message}`
      );
    }
  }
  return null;
}

// Collect all benchmark data
function collectBenchmarkData(resultFiles) {
  // Structure: { [benchmarkName]: { [app]: { [backend]: { wallTime, workflowTime, overhead, min, max, samples, firstByteTime } } } }
  const data = {};

  for (const file of resultFiles) {
    const parsed = parseFilename(path.basename(file));
    if (!parsed) continue;

    const { app, backend } = parsed;

    try {
      const results = JSON.parse(fs.readFileSync(file, 'utf-8'));
      const timings = loadTimingData(file);

      for (const fileData of results.files || []) {
        for (const group of fileData.groups || []) {
          for (const bench of group.benchmarks || []) {
            // Skip benchmarks without valid timing data (failed or timed out)
            if (bench.mean === undefined || bench.mean === null) {
              continue;
            }

            const benchName = bench.name;

            if (!data[benchName]) {
              data[benchName] = {};
            }
            if (!data[benchName][app]) {
              data[benchName][app] = {};
            }

            // Get workflow timing if available
            let workflowTimeMs = null;
            let firstByteTimeMs = null;
            if (timings?.summary?.[benchName]) {
              workflowTimeMs = timings.summary[benchName].avgExecutionTimeMs;
              // Get TTFB for stream benchmarks
              if (timings.summary[benchName].avgFirstByteTimeMs !== undefined) {
                firstByteTimeMs = timings.summary[benchName].avgFirstByteTimeMs;
              }
            }

            data[benchName][app][backend] = {
              wallTime: bench.mean,
              workflowTime: workflowTimeMs,
              overhead:
                workflowTimeMs !== null ? bench.mean - workflowTimeMs : null,
              min: bench.min,
              max: bench.max,
              samples: bench.sampleCount,
              firstByteTime: firstByteTimeMs,
            };
          }
        }
      }
    } catch (e) {
      console.error(
        `Warning: Could not parse benchmark file ${file}: ${e.message}`
      );
    }
  }

  return data;
}

// Get all apps and backends from the data
function getAppsAndBackends(data) {
  const apps = new Set();
  const backends = new Set();

  for (const benchData of Object.values(data)) {
    for (const app of Object.keys(benchData)) {
      apps.add(app);
      for (const backend of Object.keys(benchData[app])) {
        backends.add(backend);
      }
    }
  }

  // Sort: local, postgres, vercel for backends
  const backendOrder = ['local', 'postgres', 'vercel'];
  const sortedBackends = [...backends].sort(
    (a, b) => backendOrder.indexOf(a) - backendOrder.indexOf(b)
  );

  // Sort apps alphabetically
  const sortedApps = [...apps].sort();

  return { apps: sortedApps, backends: sortedBackends };
}

// Check if a benchmark has TTFB data (is a stream benchmark)
function isStreamBenchmark(benchData, apps, backends) {
  for (const app of apps) {
    for (const backend of backends) {
      if (benchData[app]?.[backend]?.firstByteTime !== null) {
        return true;
      }
    }
  }
  return false;
}

// Render a single benchmark table
function renderBenchmarkTable(benchName, benchData, apps, backends, isStream) {
  console.log(`## ${benchName}\n`);

  // Collect all data points (including missing ones) for all app/backend combinations
  const dataPoints = [];
  const validDataPoints = [];
  for (const app of apps) {
    for (const backend of backends) {
      const metrics = benchData[app]?.[backend];
      const dataPoint = { app, backend, metrics: metrics || null };
      dataPoints.push(dataPoint);
      if (metrics) {
        validDataPoints.push(dataPoint);
      }
    }
  }

  if (validDataPoints.length === 0) {
    console.log('_No data available_\n');
    return;
  }

  // Sort valid data points by workflow time for ranking
  validDataPoints.sort((a, b) => {
    const aTime = a.metrics.workflowTime ?? a.metrics.wallTime;
    const bTime = b.metrics.workflowTime ?? b.metrics.wallTime;
    return aTime - bTime;
  });
  const fastest = validDataPoints[0];
  const fastestTime = fastest.metrics.workflowTime ?? fastest.metrics.wallTime;

  // Sort all data points: valid ones first (by time), then missing ones
  dataPoints.sort((a, b) => {
    // Missing data goes to the end
    if (!a.metrics && !b.metrics) return 0;
    if (!a.metrics) return 1;
    if (!b.metrics) return -1;
    // Valid data sorted by time
    const aTime = a.metrics.workflowTime ?? a.metrics.wallTime;
    const bTime = b.metrics.workflowTime ?? b.metrics.wallTime;
    return aTime - bTime;
  });

  // Render table - different columns for stream vs regular benchmarks
  if (isStream) {
    console.log(
      '| Backend | Framework | Workflow Time | TTFB | Wall Time | Overhead | vs Fastest |'
    );
    console.log(
      '|:--------|:----------|--------------:|-----:|----------:|---------:|-----------:|'
    );
  } else {
    console.log(
      '| Backend | Framework | Workflow Time | Wall Time | Overhead | vs Fastest |'
    );
    console.log(
      '|:--------|:----------|--------------:|----------:|---------:|-----------:|'
    );
  }

  for (const { app, backend, metrics } of dataPoints) {
    const backendInfo = backendConfig[backend] || {
      emoji: '',
      label: backend,
    };
    const frameworkInfo = frameworkConfig[app] || { label: app };

    // Handle missing data
    if (!metrics) {
      if (isStream) {
        console.log(
          `| ${backendInfo.emoji} ${backendInfo.label} | ${frameworkInfo.label} | ⚠️ _missing_ | - | - | - | - |`
        );
      } else {
        console.log(
          `| ${backendInfo.emoji} ${backendInfo.label} | ${frameworkInfo.label} | ⚠️ _missing_ | - | - | - |`
        );
      }
      continue;
    }

    const isFastest = metrics === fastest.metrics;
    const medal = isFastest ? '🥇 ' : '';

    const workflowTimeSec =
      metrics.workflowTime !== null ? formatSec(metrics.workflowTime) : '-';
    const wallTimeSec = formatSec(metrics.wallTime);
    const overheadSec =
      metrics.overhead !== null ? formatSec(metrics.overhead) : '-';
    const firstByteSec =
      metrics.firstByteTime !== null ? formatSec(metrics.firstByteTime) : '-';

    const currentTime = metrics.workflowTime ?? metrics.wallTime;
    const factor = isFastest
      ? '1.00x'
      : `${(currentTime / fastestTime).toFixed(2)}x`;

    if (isStream) {
      console.log(
        `| ${backendInfo.emoji} ${backendInfo.label} | ${medal}${frameworkInfo.label} | ${workflowTimeSec}s | ${firstByteSec}s | ${wallTimeSec}s | ${overheadSec}s | ${factor} |`
      );
    } else {
      console.log(
        `| ${backendInfo.emoji} ${backendInfo.label} | ${medal}${frameworkInfo.label} | ${workflowTimeSec}s | ${wallTimeSec}s | ${overheadSec}s | ${factor} |`
      );
    }
  }
  console.log('');
}

// Render the comparison tables
function renderComparison(data) {
  const { apps, backends } = getAppsAndBackends(data);

  if (Object.keys(data).length === 0) {
    console.log('No benchmark data found.\n');
    return;
  }

  console.log('<!-- benchmark-results -->\n');
  console.log('## 📊 Benchmark Results\n');

  // Separate benchmarks into regular and stream categories
  const regularBenchmarks = [];
  const streamBenchmarks = [];

  for (const [benchName, benchData] of Object.entries(data)) {
    if (isStreamBenchmark(benchData, apps, backends)) {
      streamBenchmarks.push([benchName, benchData]);
    } else {
      regularBenchmarks.push([benchName, benchData]);
    }
  }

  // Render regular benchmarks first
  if (regularBenchmarks.length > 0) {
    for (const [benchName, benchData] of regularBenchmarks) {
      renderBenchmarkTable(benchName, benchData, apps, backends, false);
    }
  }

  // Render stream benchmarks in a separate section
  if (streamBenchmarks.length > 0) {
    console.log('---\n');
    console.log('### Stream Benchmarks\n');
    console.log(
      '_Stream benchmarks include Time to First Byte (TTFB) metrics._\n'
    );

    for (const [benchName, benchData] of streamBenchmarks) {
      renderBenchmarkTable(benchName, benchData, apps, backends, true);
    }
  }

  // Summary: Best framework per backend (by Workflow Time)
  console.log('## Summary: Fastest Framework by Backend\n');
  console.log('| Backend | Fastest Framework | Workflow Time |');
  console.log('|:--------|:------------------|---------------:|');

  for (const backend of backends) {
    const backendInfo = backendConfig[backend] || { emoji: '', label: backend };
    let fastestApp = null;
    let fastestTime = Infinity;

    // Average workflow time across all benchmarks for this backend
    const appTotals = {};
    const appCounts = {};

    for (const benchData of Object.values(data)) {
      for (const app of apps) {
        const metrics = benchData[app]?.[backend];
        if (metrics) {
          const time = metrics.workflowTime ?? metrics.wallTime;
          appTotals[app] = (appTotals[app] || 0) + time;
          appCounts[app] = (appCounts[app] || 0) + 1;
        }
      }
    }

    for (const app of apps) {
      if (appCounts[app] > 0) {
        const avgTime = appTotals[app] / appCounts[app];
        if (avgTime < fastestTime) {
          fastestTime = avgTime;
          fastestApp = app;
        }
      }
    }

    if (fastestApp) {
      const frameworkInfo = frameworkConfig[fastestApp] || {
        label: fastestApp,
      };
      console.log(
        `| ${backendInfo.emoji} ${backendInfo.label} | ${frameworkInfo.label} | ${formatSec(fastestTime)}s (avg) |`
      );
    }
  }
  console.log('');

  // Summary: Best backend per framework (by Workflow Time)
  console.log('## Summary: Fastest Backend by Framework\n');
  console.log('| Framework | Fastest Backend | Workflow Time |');
  console.log('|:----------|:----------------|---------------:|');

  for (const app of apps) {
    const frameworkInfo = frameworkConfig[app] || { label: app };
    let fastestBackend = null;
    let fastestTime = Infinity;

    // Average workflow time across all benchmarks for this app
    const backendTotals = {};
    const backendCounts = {};

    for (const benchData of Object.values(data)) {
      for (const backend of backends) {
        const metrics = benchData[app]?.[backend];
        if (metrics) {
          const time = metrics.workflowTime ?? metrics.wallTime;
          backendTotals[backend] = (backendTotals[backend] || 0) + time;
          backendCounts[backend] = (backendCounts[backend] || 0) + 1;
        }
      }
    }

    for (const backend of backends) {
      if (backendCounts[backend] > 0) {
        const avgTime = backendTotals[backend] / backendCounts[backend];
        if (avgTime < fastestTime) {
          fastestTime = avgTime;
          fastestBackend = backend;
        }
      }
    }

    if (fastestBackend) {
      const backendInfo = backendConfig[fastestBackend] || {
        emoji: '',
        label: fastestBackend,
      };
      console.log(
        `| ${frameworkInfo.label} | ${backendInfo.emoji} ${backendInfo.label} | ${formatSec(fastestTime)}s (avg) |`
      );
    }
  }
  console.log('');

  // Legend
  console.log('<details>');
  console.log('<summary>Column Definitions</summary>\n');
  console.log(
    '- **Workflow Time**: Runtime reported by workflow (completedAt - createdAt) - *primary metric*'
  );
  console.log(
    '- **TTFB**: Time to First Byte - time from workflow start until first stream byte received (stream benchmarks only)'
  );
  console.log(
    '- **Wall Time**: Total testbench time (trigger workflow + poll for result)'
  );
  console.log('- **Overhead**: Testbench overhead (Wall Time - Workflow Time)');
  console.log(
    '- **vs Fastest**: How much slower compared to the fastest configuration for this benchmark'
  );
  console.log('');
  console.log('**Backends:**');
  console.log('- 💻 Local: In-memory filesystem backend');
  console.log('- 🐘 Postgres: PostgreSQL database backend');
  console.log('- ▲ Vercel: Vercel production backend');
  console.log('</details>');
}

// Main
const resultFiles = findBenchmarkFiles(resultsDir);

if (resultFiles.length === 0) {
  console.log('No benchmark result files found in', resultsDir);
  process.exit(0);
}

const data = collectBenchmarkData(resultFiles);
renderComparison(data);
