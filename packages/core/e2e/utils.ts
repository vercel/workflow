import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path, { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { getCurrentTest } from '@vitest/runner';
import { createWorkflowUrl } from '@workflow/utils';
import { createWorld as createVercelTestWorld } from '@workflow/world-vercel';
import { onTestFailed } from 'vitest';
import { getTrustedSourcesHeaders } from '../../../scripts/trusted-sources-headers.mjs';
import type { Run } from '../src/runtime';
import { getWorld, start as runtimeStart, setWorld } from '../src/runtime';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultCliTimeoutMs = Number(
  process.env.WORKFLOW_E2E_CLI_TIMEOUT_MS ?? '20000'
);

/**
 * Undici reports every network-level fetch failure as `TypeError: fetch
 * failed` with the actual cause (ECONNRESET, ETIMEDOUT, DNS failure, ...)
 * attached to `error.cause`, which test reporters don't serialize. Enrich the
 * error message in place with the request target and the cause so e2e
 * failures are diagnosable from CI output alone. Only affects the test
 * process — deployed app code is untouched.
 */
function installFetchErrorDiagnostics() {
  const flag = Symbol.for('workflow.e2e.fetchErrorDiagnostics');
  const globals = globalThis as { [key: symbol]: boolean };
  if (globals[flag]) return;
  globals[flag] = true;

  const originalFetch = globalThis.fetch.bind(globalThis);
  globalThis.fetch = (async (
    input: string | URL | Request,
    init?: RequestInit
  ) => {
    try {
      return await originalFetch(input, init);
    } catch (error) {
      if (error instanceof TypeError) {
        enrichFetchError(error, input, init);
      }
      throw error;
    }
  }) as typeof fetch;
}

function enrichFetchError(
  error: TypeError,
  input: string | URL | Request,
  init?: RequestInit
) {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  const method =
    init?.method ?? (input instanceof Request ? input.method : 'GET');
  const causeDesc = describeFetchCause((error as { cause?: unknown }).cause);
  const suffix = ` (${method} ${url}${causeDesc ? ` — cause: ${causeDesc}` : ''})`;
  if (error.message.includes(suffix)) return;

  // Materialize the stack before mutating the message: V8 formats
  // `error.stack` lazily using the message at first access.
  const stack = error.stack;
  const oldHeader = `TypeError: ${error.message}`;
  error.message = `${error.message}${suffix}`;
  // Keep the stack's first line in sync with the message — reporters
  // that print only the stack would otherwise drop the enrichment.
  if (stack?.startsWith(oldHeader)) {
    error.stack = `TypeError: ${error.message}${stack.slice(oldHeader.length)}`;
  }
}

function describeFetchCause(cause: unknown): string | undefined {
  if (cause === null || cause === undefined) return undefined;
  if (cause instanceof AggregateError) {
    const parts = cause.errors.map((e) => describeFetchCause(e) ?? String(e));
    return parts.join(', ');
  }
  if (typeof cause === 'object') {
    const { code, message } = cause as { code?: string; message?: string };
    return code ?? message ?? String(cause);
  }
  return String(cause);
}

installFetchErrorDiagnostics();

function splitArgs(raw: string): string[] {
  const value = raw.trim();
  if (!value) return [];
  return value.split(/\s+/);
}

export function getWorkbenchAppPath(overrideAppName?: string): string {
  const explicitWorkbenchPath = process.env.WORKBENCH_APP_PATH;
  const appName = process.env.APP_NAME ?? overrideAppName;
  if (
    explicitWorkbenchPath &&
    (!overrideAppName || !appName || overrideAppName === appName)
  ) {
    return path.resolve(explicitWorkbenchPath);
  }

  if (!appName) {
    throw new Error('`APP_NAME` environment variable is not set');
  }
  return path.join(__dirname, '../../../workbench', appName);
}

export function isLocalDeployment(): boolean {
  const deploymentUrl = process.env.DEPLOYMENT_URL;
  if (!deploymentUrl) return false;

  const localHosts = ['localhost', '127.0.0.1'];
  return localHosts.some((host) => deploymentUrl.includes(host));
}

// ───────────────────────────────────────────────────────────────────────────
// Cross-language conformance
// ───────────────────────────────────────────────────────────────────────────

/**
 * Per-app conformance declaration, read from `e2e-conformance.json` in the
 * workbench app's directory.
 *
 * Most of the e2e suite only talks to the app over the two documented HTTP
 * routes (`manifest.json` and `flow`) plus the world, so it is language
 * agnostic by construction. A minority of it is not: some tests assert
 * JavaScript value semantics, some assert bundler or source-map behavior. An
 * app written in another language needs a way to say which half applies to it,
 * and which fixtures it has ported so far.
 *
 * This file is that declaration. `workbench/python` is the only app that ships
 * one; when it is absent every predicate below reports "JavaScript app, all
 * fixtures present", so the gating is a no-op for the JS workbench apps.
 */
export interface ConformanceConfig {
  /**
   * Implementation language of the app. Anything other than `javascript`
   * disables the tests marked JS-only in the suite.
   */
  language: string;
  /**
   * Names of the `workflows/99_e2e` fixtures this app implements — the
   * conformance baseline. It is a ratchet in both directions:
   *
   * - listed, and present in the deployed manifest → the test runs
   * - not listed, and absent from the manifest → the test skips
   * - listed, but absent from the manifest → **hard failure**
   *
   * Without that third case a renamed or unregistered fixture would silently
   * turn into a skip, and a green run would stop meaning anything.
   */
  fixtures: string[];
  /**
   * Tests to skip even though their fixture is listed, mapping the test's exact
   * name to why. The second axis exists because `fixtures` answers "did you port
   * this workflow", and some tests fail on a different question: whether the
   * app's *runtime* implements a protocol behavior the fixture happens to
   * exercise. `addTenWorkflow` is the case that forced it — the fixture is
   * ported and its own test passes, but a separate test drives the same fixture
   * through a simulated `run_created` outage and expects the runtime to bootstrap
   * the run from `run_started`.
   *
   * Ratcheted the same way as `fixtures`, in the direction that can rot: a name
   * here that matches no test in the suite is a **hard failure**, so a renamed
   * test cannot leave a stale exemption behind that silently covers nothing.
   */
  unsupported?: Record<string, string>;
}

export const CONFORMANCE_CONFIG_FILENAME = 'e2e-conformance.json';

let conformanceConfigCache: ConformanceConfig | null | undefined;

/** Loads the app's conformance declaration, or `null` when it has none. */
export function getConformanceConfig(): ConformanceConfig | null {
  if (conformanceConfigCache !== undefined) return conformanceConfigCache;

  let configPath: string;
  try {
    configPath = path.join(getWorkbenchAppPath(), CONFORMANCE_CONFIG_FILENAME);
  } catch {
    // No APP_NAME (e.g. utils' own unit tests). Nothing to declare.
    conformanceConfigCache = null;
    return conformanceConfigCache;
  }

  if (!fs.existsSync(configPath)) {
    conformanceConfigCache = null;
    return conformanceConfigCache;
  }

  const raw = fs.readFileSync(configPath, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `${configPath} is not valid JSON: ${(error as Error).message}`
    );
  }

  const { language, fixtures, unsupported } = (parsed ??
    {}) as Partial<ConformanceConfig>;
  if (typeof language !== 'string' || !Array.isArray(fixtures)) {
    throw new Error(
      `${configPath} must be an object with a string "language" and a "fixtures" array`
    );
  }
  if (
    unsupported !== undefined &&
    (typeof unsupported !== 'object' ||
      unsupported === null ||
      Array.isArray(unsupported) ||
      Object.values(unsupported).some((v) => typeof v !== 'string'))
  ) {
    throw new Error(
      `${configPath}: "unsupported" must be an object mapping a test name to the reason it is skipped`
    );
  }

  conformanceConfigCache = { language, fixtures, unsupported };
  return conformanceConfigCache;
}

/**
 * Whether the app under test is implemented in JavaScript/TypeScript.
 *
 * Gates the tests whose subject is the JS implementation rather than the
 * workflow protocol — value semantics (`this`, `.call()`, class methods,
 * `WORKFLOW_SERIALIZE`, throwing a non-Error), and the toolchain (source maps,
 * `import.meta.url`, tsconfig path aliases). Those can never pass against
 * another language, so they are skipped rather than reported as gaps.
 */
export function isJsApp(): boolean {
  const config = getConformanceConfig();
  return !config || config.language === 'javascript';
}

/**
 * Whether the app declares the given `workflows/99_e2e` fixture.
 *
 * Always `true` for an app with no conformance declaration, so the existing
 * workbench apps are unaffected.
 */
export function hasFixture(fixtureName: string): boolean {
  const config = getConformanceConfig();
  return !config || config.fixtures.includes(fixtureName);
}

/**
 * Skips the running test when the app does not declare `fixtureName`.
 *
 * Called from the `e2e()` helper in the suite, so the gate reads the fixture
 * name the test already names and no per-test annotation is needed. Marks the
 * test skipped rather than failed: a fixture that is absent from the baseline is
 * "not implemented yet", which is a gap to close, not a regression. (The
 * opposite case — declared in the baseline but missing from the deployed
 * manifest — is the hard failure raised by `getWorkflowMetadata`.)
 *
 * No-op for an app with no conformance declaration.
 */
export function requireFixture(fixtureName: string): void {
  if (hasFixture(fixtureName)) return;
  currentSkip()?.(
    `"${fixtureName}" is not listed in ${CONFORMANCE_CONFIG_FILENAME}`
  );
}

// Names matched against `unsupported` so far, so `assertUnsupportedTestsExist`
// can tell a live exemption from one whose test was renamed away.
const seenTestNames = new Set<string>();

/**
 * Skips the running test when the app declares it unsupported.
 *
 * Called from `setupRunTracking`, which every test in the suite already runs
 * through, so this needs no per-test annotation either. Unlike a missing
 * fixture, the reason is the app's own words — the config carries it.
 *
 * No-op for an app with no conformance declaration.
 */
export function requireSupported(testName: string): void {
  seenTestNames.add(testName);
  const reason = getConformanceConfig()?.unsupported?.[testName];
  if (!reason) return;
  currentSkip()?.(
    `${CONFORMANCE_CONFIG_FILENAME} declares this unsupported: ${reason}`
  );
}

/**
 * Fails when the app exempts a test name the suite never ran.
 *
 * The mirror of `getWorkflowMetadata`'s "declared but not in the manifest"
 * failure, for the other axis: an exemption is a claim about a specific test,
 * and a rename must break it loudly rather than leave it silently covering
 * nothing. Call from `afterAll` — it needs the whole file to have run.
 */
export function assertUnsupportedTestsExist(): void {
  const unsupported = getConformanceConfig()?.unsupported;
  if (!unsupported) return;
  const stale = Object.keys(unsupported).filter((n) => !seenTestNames.has(n));
  if (stale.length === 0) return;
  throw new Error(
    `${CONFORMANCE_CONFIG_FILENAME} lists "unsupported" tests that do not exist ` +
      `in this suite (renamed or removed?): ${stale.map((n) => `"${n}"`).join(', ')}`
  );
}

/**
 * Checks if step error source maps are expected to work in the current test environment.
 * TODO: ideally it should work consistently everywhere and we should fix the issues and
 *       get rid of this strange matrix
 */
export function hasStepSourceMaps(): boolean {
  const appName = process.env.APP_NAME as string;
  // Turbopack still does not consume inline sourcemaps for step bundles.
  // TODO: we need to fix this
  if (appName === 'nextjs-turbopack') {
    return false;
  }
  // V2 carve-out: the V2 combined flow handler does not yet wire up inline
  // source maps for step bundles across the framework integrations on Vercel.
  // To unblock CI while V2 source-map coverage catches up, treat every
  // framework on Vercel as not having step source maps. Re-evaluate once the
  // V2 route pipeline emits consumable source maps for all frameworks.
  // TODO: restore the per-framework matrix once source maps are wired up.
  if (!isLocalDeployment()) {
    return false;
  }

  // The Nest integration builds with `watch: false` and does not set
  // `NODE_ENV=development`, so even `nest start --watch` resolves to a
  // production build under the environment-aware source map default — step
  // bundles have no inline map (dev-on/prod-off). Users can still opt in via
  // the `sourcemap` option or the `WORKFLOW_SOURCEMAP` env var.
  if (appName === 'nest') {
    return false;
  }

  // Source maps now default to off in production builds and on only in dev
  // servers. Local prod and local postgres runs (no DEV_TEST_CONFIG) are
  // production builds, so step bundles have no source maps.
  if (!process.env.DEV_TEST_CONFIG) {
    return false;
  }

  // Works everywhere else (i.e. other frameworks in dev mode)
  return true;
}

/**
 * Checks if non-exported nested helper function names are expected to survive
 * in step error stack traces.
 */
export function hasNestedStepStackFrames(): boolean {
  const appName = process.env.APP_NAME as string;
  // Turbopack production-style builds can collapse the non-exported helper
  // frame while preserving the exported step frame and error message.
  return appName !== 'nextjs-turbopack' || Boolean(process.env.DEV_TEST_CONFIG);
}

/**
 * Checks if workflow error source maps are expected to work in the current test environment.
 * TODO: ideally it should work consistently everywhere and we should fix the issues and
 *       get rid of this strange matrix
 */
export function hasWorkflowSourceMaps(): boolean {
  const appName = process.env.APP_NAME as string;

  // Source maps now default to off in production builds and on only in dev
  // servers (the environment-aware default). In CI, DEV_TEST_CONFIG marks the
  // local dev-server runs; local prod, postgres, and Vercel runs are all
  // production builds, so the workflow VM bundle has no inline source map and
  // stack traces reference generated code.
  if (!process.env.DEV_TEST_CONFIG) {
    return false;
  }

  // These frameworks' dev servers don't produce consumable workflow source
  // maps. vite/astro/sveltekit/tanstack have pre-existing dev gaps; the Nest
  // integration builds with watch:false / no NODE_ENV=development, so even
  // `nest start --watch` resolves to a production build (maps off).
  // TODO: figure out how to get sourcemaps working in these frameworks too
  if (
    ['vite', 'astro', 'sveltekit', 'tanstack-start', 'nest'].includes(appName)
  ) {
    return false;
  }

  // Works everywhere else (other frameworks in dev mode)
  return true;
}

function getCliArgs(): string {
  const deploymentUrl = process.env.DEPLOYMENT_URL;
  if (!deploymentUrl) {
    throw new Error('`DEPLOYMENT_URL` environment variable is not set');
  }

  if (isLocalDeployment()) {
    return '';
  }

  return `--backend vercel --verbose`;
}

// ---------------------------------------------------------------------------
// Load observability
//
// The concurrent suite's cost is not obvious from pass/fail: tests can pass
// while per-test latency inflates several-fold, and the inflation can come
// from the deployment (queueing) or from the runner (every CLI assertion
// spawns a full `node` child, and a CI runner has few cores). The counters
// here make each lane report which one it was — peak test and CLI
// concurrency, CLI child count, and CLI wall time as a share of total test
// wall time — so a tuning decision has numbers behind it instead of a guess.
// ---------------------------------------------------------------------------

const loadStats = {
  cliCalls: 0,
  cliMs: 0,
  cliInFlight: 0,
  cliPeakInFlight: 0,
  testsInFlight: 0,
  testsPeakInFlight: 0,
  testMs: 0,
  durations: [] as { name: string; ms: number }[],
};

/** Called by the suite's handler wrapper when a test body starts. */
export function noteTestStarted() {
  loadStats.testsInFlight++;
  loadStats.testsPeakInFlight = Math.max(
    loadStats.testsPeakInFlight,
    loadStats.testsInFlight
  );
}

/** Called by the suite's handler wrapper when a test body settles. */
export function noteTestSettled(name: string, ms: number) {
  loadStats.testsInFlight--;
  loadStats.testMs += ms;
  loadStats.durations.push({ name, ms });
}

/**
 * One-line-per-fact load summary for the job log. Logged from `afterAll`.
 */
export function summarizeLoad(): string {
  const { durations } = loadStats;
  if (durations.length === 0) return '';
  const slowest = [...durations].sort((a, b) => b.ms - a.ms).slice(0, 10);
  const sum = durations.reduce((acc, d) => acc + d.ms, 0);
  const cliShare =
    loadStats.testMs > 0
      ? Math.round((loadStats.cliMs / loadStats.testMs) * 100)
      : 0;
  const lines = [
    '',
    '━━━ e2e load summary ━━━',
    `tests: ${durations.length} · peak concurrent: ${loadStats.testsPeakInFlight}`,
    `test wall time (summed): ${Math.round(sum / 1000)}s · median ${Math.round(
      [...durations].sort((a, b) => a.ms - b.ms)[
        Math.floor(durations.length / 2)
      ].ms
    )}ms`,
    `cli children: ${loadStats.cliCalls} · peak concurrent: ${loadStats.cliPeakInFlight} · ` +
      `wall time ${Math.round(loadStats.cliMs / 1000)}s (${cliShare}% of summed test time)`,
    'slowest tests:',
    ...slowest.map((d) => `  ${Math.round(d.ms / 1000)}s  ${d.name}`),
    '━━━━━━━━━━━━━━━━━━━━━━',
    '',
  ];
  return lines.join('\n');
}

const awaitCommand = async (
  command: string,
  args: string[],
  cwd: string,
  timeout = defaultCliTimeoutMs,
  envOverrides?: Record<string, string | undefined>
) => {
  console.log(`[Debug]: Executing ${command} ${args.join(' ')}`);
  console.log(`[Debug]: in CWD: ${cwd}`);

  loadStats.cliCalls++;
  loadStats.cliInFlight++;
  loadStats.cliPeakInFlight = Math.max(
    loadStats.cliPeakInFlight,
    loadStats.cliInFlight
  );
  const cliStartedAt = Date.now();
  const noteCliSettled = () => {
    loadStats.cliInFlight--;
    loadStats.cliMs += Date.now() - cliStartedAt;
  };

  return await new Promise<{ stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(command, args, {
        timeout,
        cwd,
        env: {
          ...process.env,
          DEBUG: '1',
          WORKFLOW_NO_UPDATE_CHECK: '1',
          ...envOverrides,
        },
      });

      let stdout = '';
      let stderr = '';

      if (child.stdout) {
        child.stdout.on('data', (chunk) => {
          const text = Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : String(chunk);
          process.stdout.write(chunk);
          stdout += text;
        });
      }

      if (child.stderr) {
        child.stderr.on('data', (chunk) => {
          const text = Buffer.isBuffer(chunk)
            ? chunk.toString('utf8')
            : String(chunk);
          process.stderr.write(chunk);
          stderr += text;
        });
      }

      child.on('error', (err) => {
        noteCliSettled();
        reject(err);
      });
      child.on('close', (code, signal) => {
        noteCliSettled();
        if (code !== 0) {
          const exitReason = signal
            ? `killed by signal ${signal}`
            : `exited with code ${code}`;
          const errorMessage = [
            `CLI command failed (${exitReason}): ${command} ${args.join(' ')}`,
            stderr ? `\n--- stderr ---\n${stderr}` : '',
            stdout ? `\n--- stdout ---\n${stdout}` : '',
          ].join('');
          reject(new Error(errorMessage));
          return;
        }
        resolve({ stdout, stderr });
      });
    }
  );
};

export const cliInspectJson = async (args: string) => {
  const cliAppPath = getWorkbenchAppPath();
  const cliArgs = splitArgs(getCliArgs());
  const inspectArgs = splitArgs(args);
  const result = await awaitCommand(
    'node',
    [
      './node_modules/workflow/bin/run.js',
      'inspect',
      '--json',
      '--decrypt',
      ...inspectArgs,
      ...cliArgs,
    ],
    cliAppPath,
    undefined,
    {
      // e2e assertions read entities immediately after writing them; the
      // analytics store ingests asynchronously and can miss the freshest
      // rows. Force the storage-backed list paths for determinism.
      WORKFLOW_DISABLE_ANALYTICS_READS: '1',
    }
  );
  if (!result.stdout.trim()) {
    throw new Error(
      [
        'CLI produced no stdout output (expected JSON)',
        result.stderr ? `\n--- stderr ---\n${result.stderr}` : '',
      ].join('')
    );
  }
  try {
    console.log('Result:', result.stdout);
    const json = JSON.parse(result.stdout);
    return { json, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    console.error('Stdout:', result.stdout);
    console.error('Stderr:', result.stderr);
    err.message = `Error parsing JSON result from CLI: ${err.message}`;
    throw err;
  }
};

/**
 * Executes the `workflow cancel` CLI command for a given run ID.
 * Returns the raw stdout/stderr from the CLI process.
 */
export const cliCancel = async (runId: string) => {
  const cliAppPath = getWorkbenchAppPath();
  const cliArgs = splitArgs(getCliArgs());
  const result = await awaitCommand(
    'node',
    ['./node_modules/workflow/bin/run.js', 'cancel', runId, ...cliArgs],
    cliAppPath,
    10_000
  );
  return result;
};

/**
 * Executes the `workflow health` CLI command and returns the parsed JSON result.
 * Uses --json flag for machine-readable output.
 */
// ============================================================================
// Shared manifest & world setup utilities
// ============================================================================

// Manifest type matching the structure from BaseBuilder.createManifest()
export interface WorkflowManifest {
  version: string;
  workflows: Record<
    string,
    Record<string, { workflowId: string; graph?: unknown }>
  >;
  steps: Record<string, Record<string, { stepId: string }>>;
  classes?: Record<string, Record<string, { classId: string }>>;
}

// Cached manifest fetched from the deployment
let cachedManifest: WorkflowManifest | null = null;
const manifestRetryTimeoutMs = Number(
  process.env.WORKFLOW_E2E_MANIFEST_RETRY_MS ?? '10000'
);
const manifestRetryIntervalMs = 250;

/**
 * Fetches the workflow manifest from the deployment URL.
 * The manifest is served at /.well-known/workflow/v1/manifest.json by each
 * workbench app when WORKFLOW_PUBLIC_MANIFEST=1 is set.
 */
export async function fetchManifest(
  deploymentUrl: string,
  options?: { forceRefresh?: boolean }
): Promise<WorkflowManifest> {
  const forceRefresh = options?.forceRefresh ?? false;
  if (cachedManifest && !forceRefresh) return cachedManifest;

  const url = createWorkflowUrl(deploymentUrl, { type: 'manifest' });
  const res = await fetch(url, {
    headers: await getTrustedSourcesHeaders(),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch manifest from ${url}: ${res.status} ${await res.text()}`
    );
  }
  cachedManifest = (await res.json()) as WorkflowManifest;
  return cachedManifest;
}

/**
 * Source extensions a workflow file may carry, across the languages the suite
 * can be pointed at.
 */
const SOURCE_EXTENSION_RE = /\.(tsx?|py)$/;

export function findWorkflowMetadataInManifest(
  manifest: WorkflowManifest,
  workflowFile: string,
  workflowFn: string
): { workflowId: string } | null {
  for (const [manifestFile, functions] of Object.entries(manifest.workflows)) {
    if (
      manifestFile.endsWith(workflowFile) ||
      workflowFile.endsWith(manifestFile)
    ) {
      const entry = functions[workflowFn];
      if (entry) {
        return entry;
      }
    }
  }

  // Strip a non-JS extension too, so an app in another language can key its
  // manifest by its own source file. The suite always looks fixtures up by the
  // TypeScript path (`workflows/99_e2e.ts`); matching on the stem is what lets
  // `workflows/99_e2e.py` answer for it.
  const fileWithoutExt = workflowFile.replace(SOURCE_EXTENSION_RE, '');
  for (const [manifestFile, functions] of Object.entries(manifest.workflows)) {
    const manifestFileWithoutExt = manifestFile.replace(
      SOURCE_EXTENSION_RE,
      ''
    );
    if (
      manifestFileWithoutExt.endsWith(fileWithoutExt) ||
      fileWithoutExt.endsWith(manifestFileWithoutExt)
    ) {
      const entry = functions[workflowFn];
      if (entry) {
        return entry;
      }
    }
  }

  return null;
}

export function getFallbackWorkflowId(
  workflowFile: string,
  workflowFn: string
): string {
  const fileWithoutExt = workflowFile.replace(/\.tsx?$/, '');
  // Keep this in sync with the SWC transform ID format. This fallback is
  // intentionally coupled so tests can continue running when manifest
  // publication lags in staged/out-of-monorepo scenarios.
  return `workflow//./${fileWithoutExt}//${workflowFn}`;
}

/**
 * Looks up the workflow metadata from the manifest for a given workflow file and function name.
 * Returns an object that can be passed directly to `start()`.
 *
 * The manifest contains the exact IDs produced by the SWC transform during the build,
 * which handles symlink resolution and path normalization correctly.
 */
export async function getWorkflowMetadata(
  deploymentUrl: string,
  workflowFile: string,
  workflowFn: string
): Promise<{ workflowId: string }> {
  let manifest = await fetchManifest(deploymentUrl);
  let metadata = findWorkflowMetadataInManifest(
    manifest,
    workflowFile,
    workflowFn
  );
  if (metadata) {
    return metadata;
  }

  // Manifest publication can lag in staged/out-of-monorepo tests, so poll
  // briefly before failing to avoid races.
  const deadline = Date.now() + manifestRetryTimeoutMs;
  while (Date.now() < deadline) {
    manifest = await fetchManifest(deploymentUrl, { forceRefresh: true });
    metadata = findWorkflowMetadataInManifest(
      manifest,
      workflowFile,
      workflowFn
    );
    if (metadata) {
      return metadata;
    }
    await sleep(manifestRetryIntervalMs);
  }

  // An app that declares a conformance baseline gets no fallback. Reaching
  // here means the fixture is in its `fixtures` list but missing from the
  // deployed manifest — the third state of the ratchet, and a regression. Fail
  // now rather than synthesize an ID that no handler will claim, which only
  // surfaces ~60s later as a test timeout.
  if (getConformanceConfig()) {
    throw new Error(
      `Workflow "${workflowFn}" is declared in ${CONFORMANCE_CONFIG_FILENAME} ` +
        `but is not in the deployed manifest for "${workflowFile}" after ` +
        `${manifestRetryTimeoutMs}ms. Either the app stopped registering it, or ` +
        `it should be removed from the "fixtures" list.`
    );
  }

  // Manifest publication can lag in staged/out-of-monorepo tests. Fall back to
  // the deterministic workflow ID format used by the transform so tests can
  // continue exercising runtime behavior.
  const fallbackWorkflowId = getFallbackWorkflowId(workflowFile, workflowFn);
  console.warn(
    `Workflow "${workflowFn}" not found in manifest for "${workflowFile}" after ${manifestRetryTimeoutMs}ms; ` +
      `falling back to ${fallbackWorkflowId}`
  );
  return { workflowId: fallbackWorkflowId };
}

/**
 * Look up a registered step's `stepId` in the deployed manifest.
 *
 * The workflow counterpart (`getWorkflowMetadata`) exists because `start()`
 * needs a workflow ID it cannot compute; this exists for the same reason on
 * the other axis. A dynamic workflow's `dynamic.steps` map takes
 * `{ stepId }` references, and the e2e runner is a separate process from the
 * deployment — it cannot import the step functions to read `.stepId` off
 * them, so it reads the deployed manifest instead.
 *
 * Fails rather than synthesizing an ID: an unregistered step would surface
 * ~60s later as a run that never completes, with nothing pointing at the
 * cause.
 */
export async function getStepMetadata(
  deploymentUrl: string,
  workflowFile: string,
  stepFn: string
): Promise<{ stepId: string }> {
  const manifest = await fetchManifest(deploymentUrl, { forceRefresh: true });
  const fileWithoutExt = workflowFile.replace(SOURCE_EXTENSION_RE, '');

  for (const [manifestFile, steps] of Object.entries(manifest.steps ?? {})) {
    const manifestFileWithoutExt = manifestFile.replace(
      SOURCE_EXTENSION_RE,
      ''
    );
    if (
      !(
        manifestFileWithoutExt.endsWith(fileWithoutExt) ||
        fileWithoutExt.endsWith(manifestFileWithoutExt)
      )
    ) {
      continue;
    }
    const entry = steps[stepFn];
    if (entry) return entry;
  }

  throw new Error(
    `Step "${stepFn}" is not in the deployed manifest for "${workflowFile}". ` +
      `Available files: ${Object.keys(manifest.steps ?? {}).join(', ')}`
  );
}

/**
 * Configures the world based on the current environment:
 * - Local: sets env vars for local filesystem backend
 * - Vercel: creates and sets a Vercel world
 * - Postgres: relies on WORKFLOW_TARGET_WORLD and WORKFLOW_POSTGRES_URL env vars set by CI
 */
export function setupWorld(deploymentUrl: string): void {
  if (isLocalDeployment()) {
    // Set base URL so the local queue can reach the running workbench app
    process.env.WORKFLOW_LOCAL_BASE_URL = deploymentUrl;

    // Set the data directory to match the workbench app's data directory.
    // We must set this explicitly (not discover it) because the data dir
    // may not exist yet when the test starts — the app creates it on first use.
    // Next.js uses .next/workflow-data, all other frameworks use .workflow-data.
    const appPath = getWorkbenchAppPath();
    const appName = process.env.APP_NAME!;
    const isNextJs = appName.includes('nextjs') || appName.includes('next-');
    const dataDirName = isNextJs ? '.next/workflow-data' : '.workflow-data';
    process.env.WORKFLOW_LOCAL_DATA_DIR = path.join(appPath, dataDirName);
  } else if (process.env.WORKFLOW_VERCEL_ENV) {
    // For Vercel tests: WORKFLOW_VERCEL_AUTH_TOKEN, WORKFLOW_VERCEL_PROJECT, etc. are set by CI.
    // Build the Vercel world explicitly with the CI-provided config rather than relying on
    // createWorld() reading these env vars (which no longer happens at runtime).
    setWorld(
      createVercelTestWorld({
        token: process.env.WORKFLOW_VERCEL_AUTH_TOKEN,
        projectConfig: {
          environment: process.env.WORKFLOW_VERCEL_ENV || undefined,
          projectId: process.env.WORKFLOW_VERCEL_PROJECT || undefined,
          projectName: process.env.WORKFLOW_VERCEL_PROJECT_NAME || undefined,
          teamId: process.env.WORKFLOW_VERCEL_TEAM || undefined,
        },
      })
    );
  }
  // For Postgres tests: WORKFLOW_TARGET_WORLD and WORKFLOW_POSTGRES_URL are set by CI
}

// ============================================================================
// Run diagnostics & tracking
// ============================================================================

interface TrackedRun {
  run: Run<any>;
  workflowFile?: string;
  workflowFn?: string;
}

/**
 * Per-test harness state: the name used to attribute runs and infra events,
 * and the runs whose diagnostics dump if the test fails.
 *
 * Concurrent suites bind one of these per test via {@link runInTestState}
 * (AsyncLocalStorage), so tests interleaving on the event loop cannot
 * clobber each other's attribution — `getCurrentTest()` is a plain module
 * variable in vitest and is wrong after any `await` under concurrency.
 * Sequential suites (dev.test.ts, e2e-agent.test.ts, e2e-region.test.ts)
 * keep the classic path: {@link setupRunTracking} resets a module-level
 * fallback that is safe when only one test runs at a time.
 */
interface PerTestState {
  testName: string;
  trackedRuns: TrackedRun[];
  /**
   * The test's own `ctx.skip`, captured where the context is unambiguous
   * (the fixture), so conformance gates called mid-test-body can skip the
   * right test — `getCurrentTest()?.context.skip` would target whichever
   * test most recently started.
   */
  skip?: (note?: string) => void;
}

const testStateStorage = new AsyncLocalStorage<PerTestState>();
let fallbackTestState: PerTestState = {
  testName: 'unknown',
  trackedRuns: [],
};
const currentTestState = (): PerTestState =>
  testStateStorage.getStore() ?? fallbackTestState;

export function createPerTestState(
  testName: string,
  skip?: (note?: string) => void
): PerTestState {
  return { testName, trackedRuns: [], skip };
}

/** ALS-bound skip when available, vitest's global otherwise. */
const currentSkip = (): ((note?: string) => void) | undefined =>
  testStateStorage.getStore()?.skip ?? getCurrentTest()?.context.skip;

/** Run `fn` with `state` bound as the ambient per-test state. */
export function runInTestState<T>(
  state: PerTestState,
  fn: () => Promise<T>
): Promise<T> {
  return testStateStorage.run(state, fn);
}

// Global list of run IDs collected for metadata (observability links)
const globalCollectedRunIds: {
  testName: string;
  runId: string;
  timestamp: string;
}[] = [];

/**
 * Returns the collected run IDs for observability metadata.
 */
export function getCollectedRunIds() {
  return globalCollectedRunIds;
}

/**
 * Track a workflow run for diagnostics. On test failure, all tracked runs
 * will have their diagnostics dumped to the console automatically.
 * Also collects the run ID for observability metadata.
 *
 * If testName is omitted, uses the name from the most recent setupRunTracking() call.
 */
export function trackRun<T>(
  run: Run<T>,
  options?: {
    testName?: string;
    workflowFile?: string;
    workflowFn?: string;
  }
): Run<T> {
  const state = currentTestState();
  const testName = options?.testName ?? state.testName;
  state.trackedRuns.push({
    run,
    workflowFile: options?.workflowFile,
    workflowFn: options?.workflowFn,
  });
  globalCollectedRunIds.push({
    testName,
    runId: run.runId,
    timestamp: new Date().toISOString(),
  });
  return run;
}

// ---------------------------------------------------------------------------
// Infra events
//
// Platform-level anomalies the harness observed and absorbed (e.g. a run the
// queue never picked up). These are backend signal, not test-flake signal:
// they are recorded to a sidecar (`e2e-infra-*.json`) that the aggregation
// script surfaces separately from test failures and flaky retries, so a
// cluster of events in one time window reads as the platform blip it is.
// ---------------------------------------------------------------------------

interface InfraEventBase {
  testName: string;
  waitedMs: number;
  timestamp: string;
}

/** A mid-suite run the queue never picked up; abandoned and replaced. */
interface RunPickupStallEvent extends InfraEventBase {
  kind: 'run-pickup-stall';
  /** The run that was abandoned. */
  runId: string;
  /** The run started in its place. */
  replacementRunId: string;
}

/**
 * A fresh deployment needed more than one warmup probe before its queue
 * consumer picked anything up (see `warmDeployment`). One event per suite,
 * not per stalled probe.
 */
interface ColdStartWarmupEvent extends InfraEventBase {
  kind: 'cold-start-warmup';
  /** First abandoned probe (what the aggregation renders). */
  runId: string;
  /** Every probe that stalled, in order. */
  stalledProbeRunIds: string[];
  /** The probe that was finally picked up, or null if the budget ran out. */
  pickedUpRunId: string | null;
}

type InfraEvent = RunPickupStallEvent | ColdStartWarmupEvent;

/** `Omit` that distributes over a union instead of collapsing it. */
type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;

const infraEvents: InfraEvent[] = [];

/** Test-only visibility into events recorded so far. */
export function getRecordedInfraEvents(): readonly InfraEvent[] {
  return infraEvents;
}

export function recordInfraEvent(
  event: DistributiveOmit<InfraEvent, 'testName' | 'timestamp'> & {
    testName?: string;
  }
) {
  infraEvents.push({
    ...event,
    testName: event.testName ?? currentTestState().testName,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Write recorded infra events to `e2e-infra-{app}-{backend}.json`.
 *
 * Merges with any existing file contents: the e2e suites run in separate
 * vitest workers with separate module state, so each worker appends its own
 * events rather than clobbering the other's. (Two workers writing in the
 * same instant could still drop events; afterAll hooks make that window
 * negligible and the sidecar is observability, not correctness.)
 */
export function writeInfraSidecar() {
  if (infraEvents.length === 0) return;

  const appName = process.env.APP_NAME || 'unknown';
  const isVercel = !!process.env.WORKFLOW_VERCEL_ENV;
  const backend = isVercel ? 'vercel' : 'local';
  const filePath = path.resolve(
    process.cwd(),
    `e2e-infra-${appName}-${backend}.json`
  );

  let existing: InfraEvent[] = [];
  try {
    existing = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {}

  fs.writeFileSync(
    filePath,
    JSON.stringify([...existing, ...infraEvents], null, 2)
  );
}

// ---------------------------------------------------------------------------
// Run pickup guard
// ---------------------------------------------------------------------------

/**
 * How long a freshly started run may sit in `pending` before the harness
 * treats it as never-picked-up. Healthy pickup is sub-second (observed
 * ~160ms on Vercel preview deployments); the budget only has to sit safely
 * above tail latency, and well below the 30–60s test timeouts so the
 * replacement run still has budget to finish in.
 */
const PICKUP_BUDGET_MS = Number(
  process.env.WORKFLOW_E2E_PICKUP_BUDGET_MS ?? '15000'
);

/**
 * Poll until the run leaves `pending` (picked up — any other status counts,
 * including terminal ones). Returns false if it is still `pending` after
 * `budgetMs`. The common path costs a single status read.
 */
export async function waitForRunPickup(
  run: Run<unknown>,
  budgetMs: number = PICKUP_BUDGET_MS
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  let interval = 500;

  for (;;) {
    try {
      if ((await run.status) !== 'pending') return true;
    } catch {
      // Transient status-read failure: keep polling until the budget ends.
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(interval, remaining));
    interval = Math.min(interval * 2, 5_000);
  }
}

/**
 * `start()` + `trackRun()` with a pickup watchdog.
 *
 * A run that is still `pending` after {@link PICKUP_BUDGET_MS} was never
 * invoked: queue delivery to the deployment stalled (observed as clusters of
 * runs stuck at `run_created` across apps during backend blips). No workflow
 * code has executed — no hooks registered, no steps run — so abandoning the
 * run and starting a replacement is side-effect-free, unlike retrying a
 * whole test. One replacement, recorded loudly as an infra event; if the
 * replacement stalls too, the test fails on its own timeouts and the
 * CI-level retry remains the backstop.
 */
export async function startTracked<T>(
  ...args: Parameters<typeof runtimeStart<T>>
): Promise<Run<T>> {
  const run = await runtimeStart<T>(...args);
  trackRun(run);
  if (await waitForRunPickup(run)) {
    return run;
  }

  const replacement = await runtimeStart<T>(...args);
  trackRun(replacement);
  recordInfraEvent({
    kind: 'run-pickup-stall',
    runId: run.runId,
    replacementRunId: replacement.runId,
    waitedMs: PICKUP_BUDGET_MS,
  });
  console.warn(
    `[e2e] run ${run.runId} was never picked up (pending > ${PICKUP_BUDGET_MS}ms); ` +
      `replaced with ${replacement.runId} (infra event, not a test failure)`
  );
  // Best-effort: keep the zombie from executing if the queue delivers late.
  void run
    .cancel({ cancelReason: 'e2e: stuck pending, replaced by watchdog' })
    .catch(() => {});
  return replacement;
}

/**
 * Total budget for warming a fresh deployment before the suite runs.
 */
const WARMUP_BUDGET_MS = Number(
  process.env.WORKFLOW_E2E_WARMUP_BUDGET_MS ?? '120000'
);

/**
 * Warm a cold target before the first test starts a run.
 *
 * A target answers HTTP well before its first run is picked up promptly,
 * for two reasons with one shape: a fresh Vercel deployment's queue
 * consumer takes a while to start delivering, and a local dev server pays
 * its first flow-route compile on the first delivery (observed as the
 * suite's first test recording a pickup stall on local-dev lanes, `waitedMs`
 * pegged at the full pickup budget). Either way the stalls the watchdog
 * absorbs cluster on the suite's first tests, which drowns the infra
 * telemetry in cold-start noise and leaves those tests one stalled
 * replacement away from failing.
 *
 * Probes follow the watchdog's shape: start a throwaway run, and if it is
 * still `pending` after `WORKFLOW_E2E_PICKUP_BUDGET_MS`, abandon it
 * (best-effort cancel) and probe again, until a probe is picked up or
 * `WORKFLOW_E2E_WARMUP_BUDGET_MS` is spent. A picked-up probe is left to
 * finish on its own — pickup is what proves the pipeline is awake. A warmup
 * that needed abandoned probes is recorded as a single `cold-start-warmup`
 * infra event instead of per-test `run-pickup-stall` noise.
 *
 * If the budget runs out the suite proceeds anyway: the per-test watchdog
 * still guards every start, and test failures carry the run diagnostics a
 * thrown warmup would not.
 */
export async function warmDeployment(
  startProbe: () => Promise<Run<unknown>>,
  {
    pickupBudgetMs = PICKUP_BUDGET_MS,
    totalBudgetMs = WARMUP_BUDGET_MS,
  }: { pickupBudgetMs?: number; totalBudgetMs?: number } = {}
): Promise<void> {
  const startedAt = Date.now();
  const deadline = startedAt + totalBudgetMs;
  const stalledProbeRunIds: string[] = [];

  const record = (pickedUpRunId: string | null) => {
    if (stalledProbeRunIds.length === 0) return;
    recordInfraEvent({
      kind: 'cold-start-warmup',
      testName: 'suite warmup',
      runId: stalledProbeRunIds[0],
      stalledProbeRunIds: [...stalledProbeRunIds],
      pickedUpRunId,
      waitedMs: Date.now() - startedAt,
    });
  };

  for (;;) {
    const probe = await startProbe();
    const remaining = deadline - Date.now();
    if (await waitForRunPickup(probe, Math.min(pickupBudgetMs, remaining))) {
      record(probe.runId);
      if (stalledProbeRunIds.length > 0) {
        console.warn(
          `[e2e] deployment warmup: ${stalledProbeRunIds.length} probe(s) ` +
            `stalled before ${probe.runId} was picked up ` +
            `(${Date.now() - startedAt}ms; infra event, not a test failure)`
        );
      }
      return;
    }

    stalledProbeRunIds.push(probe.runId);
    void probe
      .cancel({ cancelReason: 'e2e: warmup probe stuck pending, abandoned' })
      .catch(() => {});

    if (deadline - Date.now() <= 0) {
      record(null);
      console.warn(
        `[e2e] deployment warmup: no probe picked up within ` +
          `${totalBudgetMs}ms (${stalledProbeRunIds.length} abandoned); ` +
          `proceeding — the per-test pickup watchdog still guards`
      );
      return;
    }
  }
}

/**
 * Build a Vercel observability dashboard URL for a workflow run.
 */
function getObservabilityDashboardUrl(runId: string): string | null {
  const teamSlug = 'vercel-labs';
  const projectSlug = process.env.WORKFLOW_VERCEL_PROJECT_SLUG;
  const env = process.env.WORKFLOW_VERCEL_ENV;
  if (!projectSlug || !env) return null;

  const environment = env === 'production' ? 'production' : 'preview';
  return `https://vercel.com/${teamSlug}/${projectSlug}/workflows/runs/${runId}?environment=${environment}`;
}

/**
 * Fetch run diagnostics via the world API. Returns a formatted string.
 */
async function getRunDiagnostics(tracked: TrackedRun): Promise<string> {
  const { run, workflowFile, workflowFn } = tracked;
  const lines: string[] = [
    '',
    '━━━ Workflow Run Diagnostics ━━━',
    `Run ID:     ${run.runId}`,
  ];

  try {
    const world = await getWorld();
    const runData = await world.runs.get(run.runId);

    lines.push(`Status:     ${runData.status}`);
    lines.push(`Workflow:   ${runData.workflowName}`);

    if (runData.createdAt) {
      lines.push(`Created:    ${runData.createdAt.toISOString()}`);
    }
    if (runData.startedAt) {
      lines.push(`Started:    ${runData.startedAt.toISOString()}`);
    }
    if (runData.completedAt) {
      lines.push(`Completed:  ${runData.completedAt.toISOString()}`);
    }

    if (runData.input !== undefined) {
      const inputStr = JSON.stringify(runData.input);
      lines.push(
        `Input:      ${inputStr.length > 200 ? `${inputStr.slice(0, 200)}...` : inputStr}`
      );
    }
    if (runData.output !== undefined) {
      const outputStr = JSON.stringify(runData.output);
      lines.push(
        `Output:     ${outputStr.length > 200 ? `${outputStr.slice(0, 200)}...` : outputStr}`
      );
    }
    if (runData.error) {
      lines.push(
        `Error:      ${runData.error.message || JSON.stringify(runData.error)}`
      );
      if (runData.error.stack) {
        lines.push(
          `Stack:      ${runData.error.stack.split('\n').slice(0, 3).join('\n            ')}`
        );
      }
    }

    // Event timeline
    try {
      const { data: events } = await world.events.list({
        runId: run.runId,
      });
      if (events.length > 0) {
        lines.push('');
        lines.push('Event Timeline:');
        const baseTime = events[0].createdAt?.getTime?.() ?? 0;
        for (const event of events) {
          const elapsed = baseTime
            ? ((event.createdAt?.getTime?.() ?? 0) - baseTime) / 1000
            : 0;
          const prefix = `  +${elapsed.toFixed(1)}s`;
          let detail = event.eventType;
          if ('eventData' in event) {
            const data = (event as any).eventData;
            if (data?.stepName) detail += ` (${data.stepName})`;
            if (data?.error?.message) detail += ` — ${data.error.message}`;
          }
          if ('correlationId' in event && event.correlationId) {
            detail += ` [${event.correlationId}]`;
          }
          lines.push(`${prefix}  ${detail}`);
        }
      }
    } catch {
      lines.push('Events:     (failed to fetch)');
    }
  } catch (e) {
    lines.push(`Status:     (failed to fetch: ${(e as Error).message})`);
  }

  // Source reference
  if (workflowFile) {
    const source = workflowFn
      ? `${workflowFile} → ${workflowFn}`
      : workflowFile;
    lines.push(`Source:     ${source}`);
  }

  // Dashboard link
  const dashboardUrl = getObservabilityDashboardUrl(run.runId);
  if (dashboardUrl) {
    lines.push(`Dashboard:  ${dashboardUrl}`);
  }

  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push('');

  return lines.join('\n');
}

/**
 * Emit a GitHub Actions annotation for a failed test.
 *
 * We intentionally omit `file=` here because the workflow source files
 * in workbench/ are symlinks that GitHub can't resolve to repo paths.
 * The custom reporter (github-reporter.ts) emits file-linked annotations
 * using the actual test file paths instead.
 */
function emitGitHubAnnotation(
  testName: string,
  tracked: TrackedRun,
  message: string
) {
  if (!process.env.CI) return;

  const { run } = tracked;
  const dashboardUrl = getObservabilityDashboardUrl(run.runId);
  const parts = [`Run ${run.runId}`];
  if (dashboardUrl) parts.push(dashboardUrl);
  parts.push(message.split('\n')[0].slice(0, 200));

  const annotation = parts.join(' | ');

  // Write directly to stdout bypassing vitest's console interceptor.
  // Vitest prefixes console.log output with ANSI codes which prevents
  // GitHub Actions from parsing the ::error workflow command.
  process.stdout.write(`\n::error title=E2E: ${testName}::${annotation}\n`);
}

/**
 * Call inside a beforeEach() or at the start of a test to enable automatic
 * diagnostics on failure. Registers a vitest `onTestFailed` hook that dumps
 * run info for all tracked runs created during the test.
 *
 * Usage:
 *   beforeEach((ctx) => { setupRunTracking(ctx.task.name); });
 */
export function setupRunTracking(testName: string) {
  fallbackTestState = createPerTestState(testName);

  // Second conformance gate. Sited here because every test in the suite calls
  // setupRunTracking from `beforeEach`, which makes this the one place that
  // sees a test's name without the test having to declare anything.
  requireSupported(testName);

  announceTestStart(testName);
  const state = fallbackTestState;
  onTestFailed(
    (result) => dumpTrackedRunDiagnostics(state, result.errors?.[0]?.message),
    30_000 // Allow 30s for diagnostics fetching (default hookTimeout is 10s)
  );
}

/**
 * Heartbeat: announce the test the moment it starts, written straight to
 * stdout to bypass vitest's per-file console buffering. Without this, a
 * test that stalls (e.g. polling a run that never progresses) produces no
 * output until its timeout, making CI look like a silent hang — the
 * reporter only prints a test's result line once it completes. Emitting the
 * name on start makes the stalling test immediately identifiable.
 */
export function announceTestStart(testName: string) {
  process.stdout.write(`\n[e2e] ▶ start: ${testName}\n`);
}

/**
 * Dump diagnostics for every run tracked by `state`. Shared by the
 * sequential path (setupRunTracking's onTestFailed) and the concurrent
 * fixture, which passes the state it bound for its own test — the one
 * thing vitest's globals cannot provide under concurrency.
 */
export async function dumpTrackedRunDiagnostics(
  state: PerTestState,
  errorMessage = 'Test failed'
) {
  for (const tracked of state.trackedRuns) {
    try {
      const diagnostics = await getRunDiagnostics(tracked);
      console.error(diagnostics);
      emitGitHubAnnotation(state.testName, tracked, errorMessage);
    } catch {
      console.error(
        `[diagnostics] Failed to fetch diagnostics for run ${tracked.run.runId}`
      );
    }
  }
}

/**
 * Write diagnostics sidecar file with per-test run info for the aggregation script.
 * Should be called in afterAll().
 */
export function writeDiagnosticsSidecar() {
  if (globalCollectedRunIds.length === 0) return;

  const appName = process.env.APP_NAME || 'unknown';
  const isVercel = !!process.env.WORKFLOW_VERCEL_ENV;
  const backend = isVercel ? 'vercel' : 'local';
  const filePath = path.resolve(
    process.cwd(),
    `e2e-diagnostics-${appName}-${backend}.json`
  );

  const diagnostics = globalCollectedRunIds.map((entry) => ({
    ...entry,
    dashboardUrl: getObservabilityDashboardUrl(entry.runId),
  }));

  fs.writeFileSync(filePath, JSON.stringify(diagnostics, null, 2));
}

export const cliHealthJson = async (options?: { timeout?: number }) => {
  const cliAppPath = getWorkbenchAppPath();
  const cliArgs = splitArgs(getCliArgs());

  const args = ['./node_modules/workflow/bin/run.js', 'health', '--json'];

  if (options?.timeout) {
    args.push(`--timeout=${options.timeout}`);
  }
  args.push(...cliArgs);

  // Build environment overrides for the CLI process
  const envOverrides: Record<string, string> = {};

  // For local deployments, set WORKFLOW_LOCAL_BASE_URL from DEPLOYMENT_URL
  // since different frameworks use different default ports (Astro: 4321, SvelteKit: 5173, etc.)
  if (isLocalDeployment() && process.env.DEPLOYMENT_URL) {
    envOverrides.WORKFLOW_LOCAL_BASE_URL = process.env.DEPLOYMENT_URL;
  }

  const result = await awaitCommand(
    'node',
    args,
    cliAppPath,
    45_000,
    envOverrides
  );
  if (!result.stdout.trim()) {
    throw new Error(
      [
        'CLI health check produced no stdout output (expected JSON)',
        result.stderr ? `\n--- stderr ---\n${result.stderr}` : '',
      ].join('')
    );
  }
  try {
    console.log('Health check result:', result.stdout);
    const json = JSON.parse(result.stdout);
    return { json, stdout: result.stdout, stderr: result.stderr };
  } catch (err) {
    console.error('Stdout:', result.stdout);
    console.error('Stderr:', result.stderr);
    (err as Error).message =
      `Error parsing JSON result from health CLI: ${(err as Error).message}`;
    throw err;
  }
};

/**
 * Poll `cliInspectJson(args)` until `predicate(json)` holds, or the timeout
 * elapses — in which case the LAST result is returned so the caller's
 * assertions still run and produce a real failure message.
 *
 * Needed for step/event listing assertions made right after a run settles:
 * on the vercel world these listings are served analytics-first from an
 * eventually-consistent store, so rows for just-finished steps can be
 * missing or carry stale pending/running statuses for a few seconds
 * before converging on the durable state.
 */
export const cliInspectJsonUntil = async (
  args: string,
  predicate: (json: any) => boolean,
  {
    timeoutMs = 30_000,
    intervalMs = 2_000,
  }: { timeoutMs?: number; intervalMs?: number } = {}
): Promise<any> => {
  const deadline = Date.now() + timeoutMs;
  // biome-ignore lint/suspicious/noExplicitAny: raw CLI JSON
  let json: any;
  for (;;) {
    ({ json } = await cliInspectJson(args));
    let satisfied = false;
    try {
      satisfied = predicate(json);
    } catch {
      // Malformed intermediate state (e.g. `.find()` returned undefined)
      // counts as not-yet-converged.
    }
    if (satisfied || Date.now() >= deadline) return json;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
};
