#!/usr/bin/env node
/**
 * Measures the generated artifacts for a workbench app's
 * `/.well-known/workflow/v1/flow` route after that app has been built, and
 * writes a JSON report consumed by render-bundle-size-comment.mjs.
 *
 * Two tiers are reported, because neither supported app emits an isolable
 * function bundle for the flow route:
 *
 *   Tier 1 (gated) - the route plus its largest active VM sidecar, and the step
 *     registrations emitted by the workflow builders before the framework
 *     bundles them. These are deterministic and move only when the SDK or
 *     application workflows move.
 *
 *   Tier 2 (informational) - the framework's own deployable output. For
 *     Next.js the built route file is a ~1 KB turbopack chunk loader, so the
 *     real number is the sum of the chunks it pulls in; those chunks are
 *     shared with other routes, so the figure over-counts what the flow route
 *     exclusively owns. For nitro the flow handler is inlined into the single
 *     server entry, so there is no per-route file at all and the whole server
 *     output is reported.
 *
 * The two tiers are NOT comparable to each other, and neither alone is the
 * deployed flow function. Tier 1 approximates the largest builder-owned input
 * one cold replay loads: the generated route plus its selected VM sidecar. The
 * framework code hosting those artifacts, including the world adapter, lives
 * in Tier 2. Each metric is compared only with its own baseline.
 *
 * What Tier 1 therefore does NOT cover: the world adapters. Measured on
 * nextjs-turbopack, building with WORKFLOW_TARGET_WORLD=local and =vercel
 * produces byte-identical reports across all three metrics, because every
 * world the app depends on is bundled into the framework output regardless and
 * the choice is made at runtime. A change confined to @workflow/world-vercel
 * will not move the gated numbers.
 *
 * Every failure path here exits non-zero with the path it looked at. A
 * plausible-looking wrong number (the 1 KB chunk loader, a months-old stale
 * bundle) is worse than a red job, because it reports green while measuring
 * nothing.
 *
 * Usage:
 *   node .github/scripts/measure-flow-bundle.mjs --app hono --out sizes.json
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..'
);

/** Bump when the shape changes incompatibly; the renderer refuses older reports. */
const SCHEMA_VERSION = 1;

/**
 * Build-time env that changes the measured bytes. Recorded into every report
 * so the renderer can refuse to diff two reports that were not produced the
 * same way. Without this, editing the workflow file silently invalidates every
 * historical comparison and nothing tells you.
 *
 * WORKFLOW_SOURCEMAP is the one that dominates the numbers. It defaults to
 * inline outside a production build, and an inline-sourcemap build of
 * nextjs-turbopack measures 5.85 MB against 1.38 MB with sourcemaps off.
 *
 * WORKFLOW_TARGET_WORLD is pinned and fingerprinted despite having no measured
 * effect today: local and vercel builds of nextjs-turbopack come out
 * byte-identical. packages/next/src/index.ts does branch on it, so it is the
 * kind of input that can start mattering; recording it means a build that
 * changes worlds refuses to diff against an old baseline instead of silently
 * reporting the difference as a code change.
 */
const FINGERPRINT_ENV = [
  'WORKFLOW_TARGET_WORLD',
  'WORKFLOW_SOURCEMAP',
  'WORKFLOW_PUBLIC_MANIFEST',
];

/**
 * Generated sidecars that sit next to the real bundles and must never be
 * counted. All of these exist in a working tree today, including leftover
 * `steps.tmp.<uuid>.mjs.debug.json` files from interrupted builds.
 */
const EXCLUDED_SUFFIXES = ['.debug.json', '.map'];
const EXCLUDED_PATTERNS = [/\.__wf_tmp\./, /\.tmp\.[0-9a-f-]{8,}\./];

/**
 * A build stamp whose mtime marks when the framework build ran. A Tier-1
 * bundle far older than this stamp means the build did not regenerate it and
 * we are about to measure a stale artifact.
 */
const BUILD_STAMPS = {
  'nextjs-turbopack': '.next/BUILD_ID',
  hono: '.output/nitro.json',
};

/** How far a Tier-1 bundle may predate the build stamp before we call it stale. */
const STALENESS_SLACK_MS = 60 * 60 * 1000;
const WORKFLOW_BUNDLE_REFERENCE =
  /import\(\s*['"]\.\/workflow-bundles\/([a-f0-9]{64}\.mjs)['"]\s*\)/g;

class MeasureError extends Error {}

function fail(message) {
  throw new MeasureError(message);
}

function parseArgs(argv) {
  const args = { app: null, out: null, commit: null };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === '--app') args.app = argv[++i];
    else if (flag === '--out') args.out = argv[++i];
    else if (flag === '--commit') args.commit = argv[++i];
    else fail(`Unknown argument: ${flag}`);
  }
  if (!args.app) fail('Missing required --app <name>');
  if (!args.out) fail('Missing required --out <file>');
  return args;
}

function isExcluded(filePath) {
  const base = path.basename(filePath);
  if (EXCLUDED_SUFFIXES.some((suffix) => base.endsWith(suffix))) return true;
  return EXCLUDED_PATTERNS.some((pattern) => pattern.test(base));
}

/**
 * Sizes one file. gzip uses level 9 so the number is reproducible for a given
 * zlib build; the Node major version is part of the fingerprint because zlib
 * ships with Node and its output can shift across releases.
 */
function measureFile(absPath, relPath) {
  let buf;
  try {
    buf = fs.readFileSync(absPath);
  } catch (error) {
    fail(`Could not read ${relPath} (${absPath}): ${error.message}`);
  }
  return {
    path: relPath,
    raw: buf.byteLength,
    gzip: zlib.gzipSync(buf, { level: 9 }).byteLength,
  };
}

/**
 * Totals a set of measured files. Per-file gzip is summed rather than gzipping
 * the concatenation: it keeps each file's contribution meaningful and does not
 * change with file order.
 */
function total(files, extra = {}) {
  return {
    raw: files.reduce((sum, f) => sum + f.raw, 0),
    gzip: files.reduce((sum, f) => sum + f.gzip, 0),
    files,
    ...extra,
  };
}

function measureFiles(appDir, relPaths) {
  const files = [];
  for (const rel of relPaths) {
    if (isExcluded(rel)) continue;
    const abs = path.join(appDir, rel);
    files.push(measureFile(abs, path.relative(REPO_ROOT, abs)));
  }
  if (files.length === 0) fail(`No files to measure under ${appDir}`);
  return total(files);
}

function measureFlowArtifacts(appDir, flowRel) {
  const flowAbs = path.join(appDir, flowRel);
  let routeCode;
  try {
    routeCode = fs.readFileSync(flowAbs, 'utf8');
  } catch (error) {
    fail(`Could not read ${flowRel} (${flowAbs}): ${error.message}`);
  }

  const bundleFiles = [
    ...new Set(
      [...routeCode.matchAll(WORKFLOW_BUNDLE_REFERENCE)].map(
        (match) => match[1]
      )
    ),
  ].sort();
  if (bundleFiles.length === 0) {
    fail(
      `Flow route ${flowRel} does not reference any content-addressed workflow sidecars.`
    );
  }

  const flowDir = path.dirname(flowRel);
  const sidecars = bundleFiles.map((file) => {
    const rel = path.join(flowDir, 'workflow-bundles', file);
    return measureFile(
      path.join(appDir, rel),
      path.relative(REPO_ROOT, path.join(appDir, rel))
    );
  });
  const route = measureFile(flowAbs, path.relative(REPO_ROOT, flowAbs));
  const largestSidecar = sidecars.reduce((largest, file) =>
    file.raw > largest.raw ? file : largest
  );

  return total([route, largestSidecar], {
    note: `route + largest of ${sidecars.length} active VM sidecars`,
  });
}

function walkFiles(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (error) {
      fail(`Could not read directory ${current}: ${error.message}`);
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && !isExcluded(full)) out.push(full);
    }
  }
  return out.sort();
}

/**
 * Reads the per-app generated bundle paths out of scripts/create-test-matrix.mjs
 * rather than restating them here. That script is the repo's single source of
 * truth for where each framework adapter writes its flow bundle (it feeds the
 * E2E dev-test matrix). It exports nothing and prints `{"app":[...]}` to
 * stdout, so we spawn it. Entries are duplicated across the canary and VM axes
 * with identical paths, so the first name match is fine.
 */
function loadMatrixEntry(app) {
  let stdout;
  try {
    stdout = execFileSync('node', ['scripts/create-test-matrix.mjs'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    fail(`Could not run scripts/create-test-matrix.mjs: ${error.message}`);
  }

  let matrix;
  try {
    matrix = JSON.parse(stdout);
  } catch (error) {
    fail(`scripts/create-test-matrix.mjs did not emit JSON: ${error.message}`);
  }

  const entry = matrix.app?.find((candidate) => candidate.name === app);
  if (!entry) {
    const known = [...new Set((matrix.app ?? []).map((a) => a.name))].join(
      ', '
    );
    fail(`App "${app}" is not in the test matrix. Known apps: ${known}`);
  }
  if (!entry.generatedWorkflowPath || !entry.generatedStepRegistrationPath) {
    fail(
      `Test matrix entry for "${app}" is missing generatedWorkflowPath or ` +
        'generatedStepRegistrationPath; this script cannot locate the flow bundle.'
    );
  }
  return entry;
}

/**
 * Guards against measuring a bundle the build did not regenerate. A working
 * tree can hold a flow bundle from an older nitro layout months out of date
 * next to a fresh `.output`, and it is the same size order of magnitude, so
 * nothing about the number itself looks wrong.
 */
function assertFresh(app, appDir, tier1RelPaths) {
  const stampRel = BUILD_STAMPS[app];
  if (!stampRel) return null;

  const stampAbs = path.join(appDir, stampRel);
  if (!fs.existsSync(stampAbs)) {
    fail(
      `Build stamp ${stampRel} is missing under ${path.relative(REPO_ROOT, appDir)}. ` +
        'The app does not look built; run its build before measuring.'
    );
  }
  const stampMtime = fs.statSync(stampAbs).mtimeMs;

  for (const rel of tier1RelPaths) {
    const abs = path.join(appDir, rel);
    if (!fs.existsSync(abs)) {
      fail(
        `Flow bundle ${rel} is missing under ${path.relative(REPO_ROOT, appDir)}. ` +
          'Either the build failed or the prebuild step that generates the ' +
          'workflow registry did not run.'
      );
    }
    const age = stampMtime - fs.statSync(abs).mtimeMs;
    if (age > STALENESS_SLACK_MS) {
      fail(
        `Flow bundle ${rel} is ${Math.round(age / 60000)} minutes older than the ` +
          `build stamp ${stampRel}. This is a stale artifact from an earlier ` +
          'build, not the one just produced. Clean the app and rebuild.'
      );
    }
  }
  return stampRel;
}

/**
 * Next.js/turbopack Tier 2. The built route file is a chunk loader:
 *
 *   var R=require("../../../../../chunks/[turbopack]_runtime.js")("server/app/.../route.js")
 *   R.c("server/chunks/[root-of-the-server]__00shnjs._.js")
 *   ... one R.c per chunk ...
 *   R.m(628681)
 *
 * `R.c` paths resolve relative to `.next/`; the runtime chunk in the leading
 * `require` resolves relative to the route file. Chunk filenames are
 * content-hashed, so only totals are stable - never key a baseline on a chunk
 * name. The syntax is a Next internal and will break on some future upgrade,
 * which is why this metric is informational and why an unparseable stub is a
 * hard error rather than a 1 KB answer.
 */
function nextTurbopackTier2(appDir) {
  const nextDir = path.join(appDir, '.next');
  const stubRel = '.next/server/app/.well-known/workflow/v1/flow/route.js';
  const stubAbs = path.join(appDir, stubRel);

  if (!fs.existsSync(stubAbs)) {
    fail(
      `Built flow route ${stubRel} is missing. Expected next build to emit it.`
    );
  }
  const stub = fs.readFileSync(stubAbs, 'utf8');

  const chunkRels = [...stub.matchAll(/R\.c\("([^"]+)"\)/g)].map((m) => m[1]);
  if (chunkRels.length === 0) {
    fail(
      `Could not find any R.c("...") chunk references in ${stubRel}. The ` +
        'turbopack chunk-loader format has probably changed; this metric needs ' +
        'updating rather than trusting the stub size on its own.'
    );
  }

  const absPaths = new Set([stubAbs]);
  for (const rel of chunkRels) {
    const abs = path.join(nextDir, rel);
    if (!fs.existsSync(abs)) {
      fail(
        `Chunk "${rel}" referenced by ${stubRel} does not resolve under .next/. ` +
          'The chunk path convention has changed.'
      );
    }
    absPaths.add(abs);
  }

  // The turbopack runtime is pulled in by the leading require(), not an R.c().
  const runtimeMatch = stub.match(/require\("([^"]*_runtime\.js)"\)/);
  if (runtimeMatch) {
    const runtimeAbs = path.resolve(path.dirname(stubAbs), runtimeMatch[1]);
    if (fs.existsSync(runtimeAbs)) absPaths.add(runtimeAbs);
  }

  const files = [...absPaths]
    .sort()
    .filter((abs) => !isExcluded(abs))
    .map((abs) => measureFile(abs, path.relative(REPO_ROOT, abs)));

  return total(files, {
    note: `${chunkRels.length} chunks, shared with other routes`,
  });
}

/**
 * Nitro Tier 2. The flow handler is inlined into the single server entry, so
 * there is nothing route-specific to isolate: report the whole server output.
 */
function nitroOutputTier2(appDir) {
  const serverRel = '.output/server';
  const serverAbs = path.join(appDir, serverRel);
  if (!fs.existsSync(serverAbs)) {
    fail(`Built server output ${serverRel} is missing under ${appDir}.`);
  }

  const files = walkFiles(serverAbs).map((abs) =>
    measureFile(abs, path.relative(REPO_ROOT, abs))
  );
  if (files.length === 0) fail(`${serverRel} contains no files.`);

  return total(files, {
    // The per-file list for a whole server tree is long and not useful in a PR
    // comment; keep the total only.
    fileCount: files.length,
    files: [],
    note: `${files.length} files, flow handler inlined into the server entry`,
  });
}

const TIER2_COLLECTORS = {
  'nextjs-turbopack': nextTurbopackTier2,
  hono: nitroOutputTier2,
};

function measureApp(app) {
  const appDir = path.join(REPO_ROOT, 'workbench', app);
  if (!fs.existsSync(appDir)) fail(`No workbench app at workbench/${app}`);

  const collectTier2 = TIER2_COLLECTORS[app];
  if (!collectTier2) {
    fail(
      `App "${app}" has no Tier 2 collector. Supported: ` +
        `${Object.keys(TIER2_COLLECTORS).join(', ')}.`
    );
  }

  // The prebuild hook generates this registry; without it the builders
  // discover no workflows and emit a trivially small bundle that still looks
  // like a valid measurement.
  if (!fs.existsSync(path.join(appDir, '_workflows.ts'))) {
    fail(
      `workbench/${app}/_workflows.ts is missing. The prebuild step ` +
        '(generate:workflows) did not run, so the flow bundle would be empty.'
    );
  }

  const entry = loadMatrixEntry(app);
  const flowRel = entry.generatedWorkflowPath;
  const stepsRel = entry.generatedStepRegistrationPath;

  assertFresh(app, appDir, [flowRel, stepsRel]);
  const flowBundle = measureFlowArtifacts(appDir, flowRel);

  const metrics = [
    {
      id: 'flow-bundle',
      label: 'Cold replay bundle',
      tier: 1,
      gated: true,
      ...flowBundle,
    },
    {
      id: 'step-registrations',
      label: 'Step registrations',
      tier: 1,
      gated: true,
      ...measureFiles(appDir, [stepsRel]),
    },
    {
      id: 'framework-output',
      label: 'Framework output',
      tier: 2,
      gated: false,
      ...collectTier2(appDir),
    },
  ];

  return metrics;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const metrics = measureApp(args.app);

  const report = {
    schemaVersion: SCHEMA_VERSION,
    app: args.app,
    commit: args.commit ?? null,
    fingerprint: {
      // Node ships zlib, so its major version can move the gzip numbers, and
      // the OS moves the raw ones: the same hono build produces 55 files under
      // .output/server on a Linux runner and 54 on macOS. CI always runs
      // ubuntu-latest, so these only ever differ when someone measures
      // somewhere else, which is exactly the comparison worth refusing.
      nodeMajor: process.versions.node.split('.')[0],
      platform: process.platform,
      arch: process.arch,
      ...Object.fromEntries(
        FINGERPRINT_ENV.map((key) => [key, process.env[key] ?? null])
      ),
    },
    metrics,
  };

  fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);

  for (const metric of metrics) {
    const kb = (metric.raw / 1024).toFixed(1);
    const gzipKb = (metric.gzip / 1024).toFixed(1);
    console.log(
      `${args.app} ${metric.id}: ${kb} KiB raw, ${gzipKb} KiB gzip` +
        `${metric.note ? ` (${metric.note})` : ''}`
    );
  }
  console.log(`Wrote ${args.out}`);
}

try {
  main();
} catch (error) {
  if (error instanceof MeasureError) {
    console.error(`measure-flow-bundle: ${error.message}`);
    process.exit(1);
  }
  throw error;
}
