#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
let resultsDir = '.';
let baselineDir = null;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--baseline' && args[i + 1]) {
    baselineDir = args[i + 1];
    i++;
  } else if (!args[i].startsWith('--')) {
    resultsDir = args[i];
  }
}

// World display config - built-in worlds
const worldConfig = {
  local: { emoji: '💻', label: 'Local' },
  postgres: { emoji: '🐘', label: 'Postgres' },
  vercel: { emoji: '▲', label: 'Vercel' },
};

// Load community worlds from manifest and add to worldConfig
const worldsManifestPath = path.join(__dirname, '../../worlds-manifest.json');
if (fs.existsSync(worldsManifestPath)) {
  try {
    const worldsManifest = JSON.parse(
      fs.readFileSync(worldsManifestPath, 'utf-8')
    );
    for (const world of worldsManifest.worlds || []) {
      // Only add community worlds (official ones are already defined above)
      if (world.type === 'community') {
        worldConfig[world.id] = {
          emoji: '🌐',
          label: world.name,
          community: true,
        };
      }
    }
  } catch (e) {
    console.error(`Warning: Could not load worlds manifest: ${e.message}`);
  }
}

// Framework display config
const frameworkConfig = {
  'nextjs-turbopack': { label: 'Next.js (Turbopack)' },
  'nitro-v3': { label: 'Nitro' },
  express: { label: 'Express' },
};

// Format milliseconds as seconds
function formatSec(ms, decimals = 3) {
  return (ms / 1000).toFixed(decimals);
}

// Format delta between current and baseline values
// Returns string like "+12.3%" (slower) or "-5.2%" (faster) or "" if no baseline
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
      const firstByteTime = benchData[app]?.[backend]?.firstByteTime;
      // Must be a number (not null or undefined) to be a stream benchmark
      if (typeof firstByteTime === 'number') {
        return true;
      }
    }
  }
  return false;
}

// Render a single benchmark table
function renderBenchmarkTable(
  benchName,
  benchData,
  baselineBenchData,
  apps,
  backends,
  isStream,
  { showHeading = true } = {}
) {
  if (showHeading) {
    console.log(`## ${benchName}\n`);
  }

  // Collect all data points (including missing ones) for all app/backend combinations
  const dataPoints = [];
  const validDataPoints = [];
  for (const app of apps) {
    for (const backend of backends) {
      // Skip community worlds for non-nextjs-turbopack frameworks (we only test them with nextjs-turbopack)
      const isCommunityWorld = worldConfig[backend]?.community === true;
      if (isCommunityWorld && app !== 'nextjs-turbopack') {
        continue;
      }

      const metrics = benchData[app]?.[backend];
      const baseline = baselineBenchData?.[app]?.[backend] || null;
      const dataPoint = { app, backend, metrics: metrics || null, baseline };
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
      '| World | Framework | Workflow Time | TTFB | Wall Time | Overhead | Samples | vs Fastest |'
    );
    console.log(
      '|:------|:----------|--------------:|-----:|----------:|---------:|--------:|-----------:|'
    );
  } else {
    console.log(
      '| World | Framework | Workflow Time | Wall Time | Overhead | Samples | vs Fastest |'
    );
    console.log(
      '|:------|:----------|--------------:|----------:|---------:|--------:|-----------:|'
    );
  }

  for (const { app, backend, metrics, baseline } of dataPoints) {
    const worldInfo = worldConfig[backend] || {
      emoji: '',
      label: backend,
    };
    const frameworkInfo = frameworkConfig[app] || { label: app };

    // Handle missing data
    if (!metrics) {
      if (isStream) {
        console.log(
          `| ${worldInfo.emoji} ${worldInfo.label} | ${frameworkInfo.label} | ⚠️ _missing_ | - | - | - | - | - |`
        );
      } else {
        console.log(
          `| ${worldInfo.emoji} ${worldInfo.label} | ${frameworkInfo.label} | ⚠️ _missing_ | - | - | - | - |`
        );
      }
      continue;
    }

    const isFastest = metrics === fastest.metrics;
    const medal = isFastest ? '🥇 ' : '';

    // Format workflow time with delta
    const workflowTimeSec =
      metrics.workflowTime !== null ? formatSec(metrics.workflowTime) : '-';
    const workflowDelta = formatDelta(
      metrics.workflowTime,
      baseline?.workflowTime
    );

    // Format wall time with delta
    const wallTimeSec = formatSec(metrics.wallTime);
    const wallDelta = formatDelta(metrics.wallTime, baseline?.wallTime);

    // Format overhead (no delta needed, it's derived)
    const overheadSec =
      metrics.overhead !== null ? formatSec(metrics.overhead) : '-';

    // Format TTFB with delta for stream benchmarks
    const firstByteSec =
      metrics.firstByteTime !== null ? formatSec(metrics.firstByteTime) : '-';
    const ttfbDelta = formatDelta(
      metrics.firstByteTime,
      baseline?.firstByteTime
    );

    // Format samples count
    const samplesCount = metrics.samples ?? '-';

    const currentTime = metrics.workflowTime ?? metrics.wallTime;
    const factor = isFastest
      ? '1.00x'
      : `${(currentTime / fastestTime).toFixed(2)}x`;

    if (isStream) {
      console.log(
        `| ${worldInfo.emoji} ${worldInfo.label} | ${medal}${frameworkInfo.label} | ${workflowTimeSec}s${workflowDelta} | ${firstByteSec}s${ttfbDelta} | ${wallTimeSec}s${wallDelta} | ${overheadSec}s | ${samplesCount} | ${factor} |`
      );
    } else {
      console.log(
        `| ${worldInfo.emoji} ${worldInfo.label} | ${medal}${frameworkInfo.label} | ${workflowTimeSec}s${workflowDelta} | ${wallTimeSec}s${wallDelta} | ${overheadSec}s | ${samplesCount} | ${factor} |`
      );
    }
  }
  console.log('');
}

// Render the comparison tables
function renderComparison(data, baselineData) {
  const { apps, backends } = getAppsAndBackends(data);

  if (Object.keys(data).length === 0) {
    console.log('No benchmark data found.\n');
    return;
  }

  console.log('<!-- benchmark-results -->\n');
  console.log('## 📊 Benchmark Results\n');

  // Show baseline comparison note if baseline data is available
  if (baselineData && Object.keys(baselineData).length > 0) {
    console.log(
      '> 📈 _Comparing against baseline from `main` branch. Green 🟢 = faster, Red 🔺 = slower._\n'
    );
  }

  // Split backends into local dev and production
  const localDevBackends = backends.filter((b) => b !== 'vercel');
  const productionBackends = backends.filter((b) => b === 'vercel');

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

  // Helper to render both local dev and production tables for a benchmark
  const renderBenchmarkWithEnvironments = (benchName, benchData, isStream) => {
    const baselineBenchData = baselineData?.[benchName] || null;

    console.log(`## ${benchName}\n`);

    // Render Local Development table
    if (localDevBackends.length > 0) {
      console.log('#### 💻 Local Development\n');
      renderBenchmarkTable(
        benchName,
        benchData,
        baselineBenchData,
        apps,
        localDevBackends,
        isStream,
        { showHeading: false }
      );
    }

    // Render Production table
    if (productionBackends.length > 0) {
      console.log('#### ▲ Production (Vercel)\n');
      renderBenchmarkTable(
        benchName,
        benchData,
        baselineBenchData,
        apps,
        productionBackends,
        isStream,
        { showHeading: false }
      );
    }
  };

  // Render regular benchmarks
  for (const [benchName, benchData] of regularBenchmarks) {
    renderBenchmarkWithEnvironments(benchName, benchData, false);
  }

  // Render stream benchmarks in a separate section
  if (streamBenchmarks.length > 0) {
    console.log('---\n');
    console.log('## Stream Benchmarks\n');
    console.log(
      '_Stream benchmarks include Time to First Byte (TTFB) metrics._\n'
    );

    for (const [benchName, benchData] of streamBenchmarks) {
      renderBenchmarkWithEnvironments(benchName, benchData, true);
    }
  }

  // Summary: Count wins per framework (within each world) and per world (within each framework)
  const allBenchmarks = [...regularBenchmarks, ...streamBenchmarks];

  // Count wins: for each world, which framework wins most benchmarks
  const frameworkWinsByWorld = {}; // { backend: { app: count } }
  // Count wins: for each framework, which world wins most benchmarks
  const worldWinsByFramework = {}; // { app: { backend: count } }

  for (const [benchName, benchData] of allBenchmarks) {
    // For each world, find the fastest framework
    for (const backend of backends) {
      let fastestApp = null;
      let fastestTime = Infinity;

      // Skip community worlds in framework comparison (they only run against nextjs-turbopack)
      const isCommunityWorld = worldConfig[backend]?.community === true;
      if (isCommunityWorld) {
        continue;
      }

      for (const app of apps) {
        const metrics = benchData[app]?.[backend];
        if (metrics) {
          const time = metrics.workflowTime ?? metrics.wallTime;
          if (time < fastestTime) {
            fastestTime = time;
            fastestApp = app;
          }
        }
      }

      if (fastestApp) {
        if (!frameworkWinsByWorld[backend]) {
          frameworkWinsByWorld[backend] = {};
        }
        frameworkWinsByWorld[backend][fastestApp] =
          (frameworkWinsByWorld[backend][fastestApp] || 0) + 1;
      }
    }

    // For each framework, find the fastest world
    for (const app of apps) {
      let fastestBackend = null;
      let fastestTime = Infinity;

      for (const backend of backends) {
        // Skip community worlds for non-nextjs-turbopack frameworks
        const isCommunityWorld = worldConfig[backend]?.community === true;
        if (isCommunityWorld && app !== 'nextjs-turbopack') {
          continue;
        }

        const metrics = benchData[app]?.[backend];
        if (metrics) {
          const time = metrics.workflowTime ?? metrics.wallTime;
          if (time < fastestTime) {
            fastestTime = time;
            fastestBackend = backend;
          }
        }
      }

      if (fastestBackend) {
        if (!worldWinsByFramework[app]) {
          worldWinsByFramework[app] = {};
        }
        worldWinsByFramework[app][fastestBackend] =
          (worldWinsByFramework[app][fastestBackend] || 0) + 1;
      }
    }
  }

  // Summary: Best framework per world (by wins)
  console.log('---\n');
  console.log('## Summary: Fastest Framework by World\n');
  console.log(`_Winner determined by most benchmark wins_\n`);
  console.log('| World | 🥇 Fastest Framework | Wins |');
  console.log('|:------|:---------------------|-----:|');

  for (const backend of backends) {
    // Skip community worlds in "Fastest Framework by World" summary
    // (they only run against nextjs-turbopack, so framework comparison doesn't apply)
    const isCommunityWorld = worldConfig[backend]?.community === true;
    if (isCommunityWorld) {
      continue;
    }

    const worldInfo = worldConfig[backend] || { emoji: '', label: backend };
    const frameworkWins = frameworkWinsByWorld[backend] || {};

    // Find framework with most wins
    let bestApp = null;
    let bestWins = 0;
    for (const [app, wins] of Object.entries(frameworkWins)) {
      if (wins > bestWins) {
        bestWins = wins;
        bestApp = app;
      }
    }

    if (bestApp) {
      const frameworkInfo = frameworkConfig[bestApp] || { label: bestApp };
      // Count total benchmarks for this world (benchmarks that have data for this world)
      const totalForWorld = allBenchmarks.filter(([, bd]) =>
        apps.some((a) => bd[a]?.[backend])
      ).length;
      console.log(
        `| ${worldInfo.emoji} ${worldInfo.label} | ${frameworkInfo.label} | ${bestWins}/${totalForWorld} |`
      );
    }
  }
  console.log('');

  // Summary: Best world per framework (by wins)
  console.log('## Summary: Fastest World by Framework\n');
  console.log(`_Winner determined by most benchmark wins_\n`);
  console.log('| Framework | 🥇 Fastest World | Wins |');
  console.log('|:----------|:-----------------|-----:|');

  for (const app of apps) {
    const frameworkInfo = frameworkConfig[app] || { label: app };
    const worldWins = worldWinsByFramework[app] || {};

    // Find world with most wins
    let bestBackend = null;
    let bestWins = 0;
    for (const [backend, wins] of Object.entries(worldWins)) {
      if (wins > bestWins) {
        bestWins = wins;
        bestBackend = backend;
      }
    }

    if (bestBackend) {
      const worldInfo = worldConfig[bestBackend] || {
        emoji: '',
        label: bestBackend,
      };
      // Count total benchmarks for this framework (benchmarks that have data for this framework)
      const totalForFramework = allBenchmarks.filter(([, bd]) =>
        backends.some((b) => bd[app]?.[b])
      ).length;
      console.log(
        `| ${frameworkInfo.label} | ${worldInfo.emoji} ${worldInfo.label} | ${bestWins}/${totalForFramework} |`
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
  console.log('- **Samples**: Number of benchmark iterations run');
  console.log(
    '- **vs Fastest**: How much slower compared to the fastest configuration for this benchmark'
  );
  console.log('');
  console.log('**Worlds:**');
  console.log('- 💻 Local: In-memory filesystem world (local development)');
  console.log('- 🐘 Postgres: PostgreSQL database world (local development)');
  console.log('- ▲ Vercel: Vercel production/preview deployment');
  // Add community worlds to legend
  for (const [id, config] of Object.entries(worldConfig)) {
    if (config.community) {
      console.log(`- 🌐 ${config.label}: Community world (local development)`);
    }
  }
  console.log('</details>');
}

// Main
const resultFiles = findBenchmarkFiles(resultsDir);

if (resultFiles.length === 0) {
  console.log('No benchmark result files found in', resultsDir);
  process.exit(0);
}

const data = collectBenchmarkData(resultFiles);

// Load baseline data if provided
let baselineData = null;
if (baselineDir) {
  const baselineFiles = findBenchmarkFiles(baselineDir);
  if (baselineFiles.length > 0) {
    baselineData = collectBenchmarkData(baselineFiles);
  }
}

renderComparison(data, baselineData);
