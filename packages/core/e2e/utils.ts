import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path, { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { createVercelWorld } from '@workflow/world-vercel';
import { onTestFailed } from 'vitest';
import type { Run } from '../src/runtime';
import { getWorld, setWorld } from '../src/runtime';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultCliTimeoutMs = Number(
  process.env.WORKFLOW_E2E_CLI_TIMEOUT_MS ?? '20000'
);

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

/**
 * Checks if step error source maps are expected to work in the current test environment.
 * TODO: ideally it should work consistently everywhere and we should fix the issues and
 *       get rid of this strange matrix
 */
export function hasStepSourceMaps(): boolean {
  // Next.js does not consume inline sourcemaps AT ALL for step bundles
  // TODO: we need to fix this
  const appName = process.env.APP_NAME as string;
  if (['nextjs-webpack', 'nextjs-turbopack'].includes(appName)) {
    return false;
  }

  // Vercel deployments (both production and preview) have proper source maps
  // for all frameworks EXCEPT sveltekit, thanks to ESM step bundles with
  // inline source maps.
  if (!isLocalDeployment()) {
    return appName !== 'sveltekit';
  }

  // Vite only works in vercel, not on local prod or dev
  if (appName === 'vite') {
    return false;
  }

  // NestJS preserves source maps in all builds including prod
  if (appName === 'nest') {
    return true;
  }

  // Prod buils for frameworks typically don't consume source maps. So let's disable testing
  // in local prod and local postgres tests
  if (!process.env.DEV_TEST_CONFIG) {
    return false;
  }

  // Works everywhere else (i.e. other frameworks in dev mode)
  return true;
}

/**
 * Checks if workflow error source maps are expected to work in the current test environment.
 * TODO: ideally it should work consistently everywhere and we should fix the issues and
 *       get rid of this strange matrix
 */
export function hasWorkflowSourceMaps(): boolean {
  const appName = process.env.APP_NAME as string;

  // Vercel deployments have proper source map support for workflow errors
  if (!isLocalDeployment()) {
    return true;
  }

  // These frameworks currently don't handle sourcemaps correctly in local dev
  // TODO: figure out how to get sourcemaps working in these frameworks too
  if (
    process.env.DEV_TEST_CONFIG &&
    ['vite', 'astro', 'sveltekit'].includes(appName)
  ) {
    return false;
  }

  // Works everywhere else
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

const awaitCommand = async (
  command: string,
  args: string[],
  cwd: string,
  timeout = defaultCliTimeoutMs,
  envOverrides?: Record<string, string | undefined>
) => {
  console.log(`[Debug]: Executing ${command} ${args.join(' ')}`);
  console.log(`[Debug]: in CWD: ${cwd}`);

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

      child.on('error', (err) => reject(err));
      child.on('close', (code, signal) => {
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

/**
 * Returns headers needed to bypass Vercel Deployment Protection.
 * When VERCEL_AUTOMATION_BYPASS_SECRET is set, includes the x-vercel-protection-bypass header.
 */
export function getProtectionBypassHeaders(): HeadersInit {
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    return {
      'x-vercel-protection-bypass': bypassSecret,
    };
  }
  return {};
}

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
    cliAppPath
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

  const url = new URL('/.well-known/workflow/v1/manifest.json', deploymentUrl);
  const res = await fetch(url, {
    headers: getProtectionBypassHeaders(),
  });
  if (!res.ok) {
    throw new Error(
      `Failed to fetch manifest from ${url}: ${res.status} ${await res.text()}`
    );
  }
  cachedManifest = (await res.json()) as WorkflowManifest;
  return cachedManifest;
}

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

  const fileWithoutExt = workflowFile.replace(/\.tsx?$/, '');
  for (const [manifestFile, functions] of Object.entries(manifest.workflows)) {
    const manifestFileWithoutExt = manifestFile.replace(/\.tsx?$/, '');
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
  // intentionally coupled so tests can continue running when deferred manifest
  // publication lags behind discovery in staged/out-of-monorepo scenarios.
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

  // Deferred discovery can grow the manifest during test execution, so poll
  // briefly before failing to avoid races in staged/out-of-monorepo mode.
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

  // Deferred discovery can lag behind manifest publication in staged/out-of-
  // monorepo tests. Fall back to the deterministic workflow ID format used by
  // the transform so tests can continue exercising runtime behavior.
  const fallbackWorkflowId = getFallbackWorkflowId(workflowFile, workflowFn);
  console.warn(
    `Workflow "${workflowFn}" not found in manifest for "${workflowFile}" after ${manifestRetryTimeoutMs}ms; ` +
      `falling back to ${fallbackWorkflowId}`
  );
  return { workflowId: fallbackWorkflowId };
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
      createVercelWorld({
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

// Per-test tracked runs — reset between tests via setupRunTracking()
let trackedRuns: TrackedRun[] = [];

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
  const testName = options?.testName ?? currentTestName;
  trackedRuns.push({
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

/**
 * Build a Vercel observability dashboard URL for a workflow run.
 */
function getObservabilityDashboardUrl(runId: string): string | null {
  const teamSlug = 'vercel-labs';
  const projectSlug = process.env.WORKFLOW_VERCEL_PROJECT_SLUG;
  const env = process.env.WORKFLOW_VERCEL_ENV;
  if (!projectSlug || !env) return null;

  const environment = env === 'production' ? 'production' : 'preview';
  return `https://vercel.com/${teamSlug}/${projectSlug}/observability/workflows/runs/${runId}?environment=${environment}`;
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
  currentTestName = testName;
  trackedRuns = [];
  onTestFailed(
    async (result) => {
      const errorMessage = result.errors?.[0]?.message || 'Test failed';

      for (const tracked of trackedRuns) {
        try {
          const diagnostics = await getRunDiagnostics(tracked);
          console.error(diagnostics);
          emitGitHubAnnotation(testName, tracked, errorMessage);
        } catch {
          console.error(
            `[diagnostics] Failed to fetch diagnostics for run ${tracked.run.runId}`
          );
        }
      }
    },
    30_000 // Allow 30s for diagnostics fetching (default hookTimeout is 10s)
  );
}

// Current test name for auto-tracking
let currentTestName = 'unknown';

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

export const cliHealthJson = async (options?: {
  endpoint?: 'workflow' | 'step' | 'both';
  timeout?: number;
}) => {
  const cliAppPath = getWorkbenchAppPath();
  const cliArgs = splitArgs(getCliArgs());

  const args = ['./node_modules/workflow/bin/run.js', 'health', '--json'];

  if (options?.endpoint) {
    args.push(`--endpoint=${options.endpoint}`);
  }
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
