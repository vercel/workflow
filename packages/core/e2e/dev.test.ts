import fs from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, assert, beforeAll, describe, expect, test } from 'vitest';
import { start } from '../src/runtime';
import { getWorkbenchAppPath, getWorkflowMetadata, setupWorld } from './utils';

export interface DevTestConfig {
  generatedStepRegistrationPath: string;
  generatedWorkflowPath: string;
  apiFilePath: string;
  apiFileImportPath: string;
  canary?: boolean;
  /** The workflow file to modify for testing HMR. Defaults to '3_streams.ts' */
  testWorkflowFile?: string;
  /** The workflows directory relative to appPath. Defaults to 'workflows' */
  workflowsDir?: string;
}

const SOURCE_MAP_WARNING = 'failed to read input source map';
const SOURCE_MAP_FIXTURE_PACKAGE = 'workflow-sourcemap-warning-fixture';
const SOURCE_MAP_COMMENT = '//# sourceMapping' + 'URL=index.js.map';

function getConfigFromEnv(): DevTestConfig | null {
  const envConfig = process.env.DEV_TEST_CONFIG;
  if (envConfig) {
    try {
      return JSON.parse(envConfig);
    } catch (e) {
      console.error('Failed to parse DEV_TEST_CONFIG:', e);
    }
  }
  return null;
}

export function createDevTests(config?: DevTestConfig) {
  const finalConfig = config || getConfigFromEnv();
  if (!finalConfig) {
    throw new Error(
      'No dev test config provided via parameter or DEV_TEST_CONFIG env var'
    );
  }
  describe('dev e2e', () => {
    // Each prewarm/trigger fetch is hard-bounded by this so cleanup never hangs
    // on a wedged dev server.
    const PREWARM_FETCH_TIMEOUT_MS = 5_000;
    // The afterEach cleanup can issue three *sequential* prewarms (before the
    // delete of an added file, after it, and after the directory removals)
    // while the dev server is mid-rebuild — the teardown of a test that added a
    // workflow file and edited an import is exactly when both rebuild and
    // respond slowly. Its budget must therefore exceed 3× PREWARM_FETCH_TIMEOUT_MS
    // (plus file IO) with headroom, or it trips vitest's 10s default hook
    // timeout. The bounded fetches mean this can't hang indefinitely, so a
    // generous budget is safe.
    //
    // Cleanup also waits for the generated step registrations to drop every
    // file it deleted, so its budget has to cover that too.
    // A delete converges in one watcher event plus one rediscovery — ~2s on the
    // macOS baseline. A watcher that dropped the unlink never converges, so a
    // large budget only delays the failure.
    const STEP_REGISTRATION_CONVERGENCE_TIMEOUT_MS =
      process.platform === 'win32' ? 60_000 : 20_000;
    const CLEANUP_HOOK_TIMEOUT_MS =
      PREWARM_FETCH_TIMEOUT_MS * 4 + STEP_REGISTRATION_CONVERGENCE_TIMEOUT_MS;
    const appPath = getWorkbenchAppPath();
    const deploymentUrl = process.env.DEPLOYMENT_URL;
    const generatedStepRegistration = path.join(
      appPath,
      finalConfig.generatedStepRegistrationPath
    );
    const generatedWorkflow = path.join(
      appPath,
      finalConfig.generatedWorkflowPath
    );
    const testWorkflowFile = finalConfig.testWorkflowFile ?? '3_streams.ts';
    const workflowsDir = finalConfig.workflowsDir ?? 'workflows';
    const usesNextFlowRoute = generatedWorkflow.includes(
      path.join('app', '.well-known', 'workflow', 'v1', 'flow', 'route.js')
    );
    const shouldRunNextFlowRouteHmrTests =
      usesNextFlowRoute && process.platform !== 'win32';
    const workflowManifestPath = path.join(
      appPath,
      'app/.well-known/workflow/v1/manifest.json'
    );
    // Next canary and Windows can queue Workflow rediscovery behind route
    // compilation long enough that the default budget races test cleanup.
    const hmrRediscoveryTimeoutMs = finalConfig.canary
      ? 180_000
      : process.platform === 'win32'
        ? 120_000
        : 50_000;
    const hmrTestTimeoutMs = finalConfig.canary
      ? 210_000
      : process.platform === 'win32'
        ? 140_000
        : 70_000;
    const multiPhaseHmrTestTimeoutMs =
      hmrTestTimeoutMs + hmrRediscoveryTimeoutMs;
    const flowRouteHmrRediscoveryTimeoutMs = finalConfig.canary
      ? process.env.APP_NAME === 'nextjs-webpack'
        ? 300_000
        : 240_000
      : hmrRediscoveryTimeoutMs;
    const flowRouteHmrFuzzTimeoutMs = finalConfig.canary ? 480_000 : 240_000;
    const readManifestStepFunctionNames = async (): Promise<string[]> => {
      const manifestJson = await fs.readFile(workflowManifestPath, 'utf8');
      const manifest = JSON.parse(manifestJson) as {
        steps?: Record<string, Record<string, unknown>>;
      };
      return Object.values(manifest.steps || {}).flatMap((entry) =>
        Object.keys(entry)
      );
    };
    const readManifestWorkflowFunctionNames = async (): Promise<string[]> => {
      const manifestJson = await fs.readFile(workflowManifestPath, 'utf8');
      const manifest = JSON.parse(manifestJson) as {
        workflows?: Record<string, Record<string, unknown>>;
      };
      return Object.values(manifest.workflows || {}).flatMap((entry) =>
        Object.keys(entry)
      );
    };
    const readGeneratedArtifactSnapshot = async () => ({
      stepMtimeMs: (await fs.stat(generatedStepRegistration)).mtimeMs,
      workflowMtimeMs: (await fs.stat(generatedWorkflow)).mtimeMs,
      manifestMtimeMs: usesNextFlowRoute
        ? (await fs.stat(workflowManifestPath)).mtimeMs
        : undefined,
    });
    const readFileIfExists = async (
      filePath: string
    ): Promise<string | null> => {
      try {
        return await fs.readFile(filePath, 'utf8');
      } catch (error) {
        if (
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOENT'
        ) {
          return null;
        }
        throw error;
      }
    };
    const readGeneratedWorkflowOutput = async (): Promise<string> => {
      const outputs = [await readFileIfExists(generatedWorkflow)].filter(
        (output): output is string => output !== null
      );

      if (outputs.length === 0) {
        throw new Error('Generated workflow outputs were not found');
      }

      return outputs.join('\n');
    };
    const restoreFiles: Array<{ path: string; content: string }> = [];
    const restoreDirectories: string[] = [];
    /**
     * The generated step registrations import every discovered step file by
     * path, so deleting a file that declares a step only stops breaking the
     * flow route once a rediscovery has regenerated them. A watcher that drops
     * the unlink therefore leaves the generated file importing a path that no
     * longer exists: the flow route stops compiling and every later workflow
     * dispatch in the job gets a 500 that points at the fixture rather than at
     * whatever test is running. The generated workflow bundle inlines workflow
     * sources instead of importing them, so only step files can strand it.
     */
    const appRelativePosixPath = (filePath: string) =>
      path.relative(appPath, filePath).split(path.sep).join('/');
    const findStrandedStepRegistrations = async (deletedPaths: string[]) => {
      const registrations =
        (await readFileIfExists(generatedStepRegistration)) ?? '';
      return deletedPaths.filter((filePath) =>
        registrations.includes(appRelativePosixPath(filePath))
      );
    };
    /**
     * Deleted files whose contents are still importable are harmless, so on a
     * convergence failure the fixture is written back: the shared dev server
     * keeps serving the rest of the suite instead of 500ing on every request,
     * and the failure surfaces here, where it is diagnosable.
     */
    const waitForDeletedFilesToLeaveStepRegistrations = async (
      deleted: Array<{ path: string; content: string }>
    ) => {
      if (deleted.length === 0) {
        return;
      }
      const deletedPaths = deleted.map((item) => item.path);
      try {
        await pollUntil({
          description:
            'generated step registrations to drop the deleted workflow files',
          timeoutMs: STEP_REGISTRATION_CONVERGENCE_TIMEOUT_MS,
          intervalMs: 250,
          check: async () => {
            expect(await findStrandedStepRegistrations(deletedPaths)).toEqual(
              []
            );
          },
        });
      } catch {
        const stranded = await findStrandedStepRegistrations(deletedPaths);
        await Promise.all(
          deleted
            .filter((item) => stranded.includes(item.path))
            .map((item) => fs.writeFile(item.path, item.content))
        );
        throw new Error(
          `Deleted workflow files are still imported by ${finalConfig.generatedStepRegistrationPath} ` +
            `after ${STEP_REGISTRATION_CONVERGENCE_TIMEOUT_MS}ms: ${stranded
              .map(appRelativePosixPath)
              .join(', ')}. The dev server missed the deletion, so the flow ` +
            'route would 500 for every later request. The files have been ' +
            'restored to keep the dev server usable.'
        );
      }
    };
    const devServerLogPath = process.env.DEV_SERVER_LOG_PATH;
    const shouldAssertDevHmrLogs = process.env.WORKFLOW_DEV_HMR_LOGS === '1';
    const hmrLogMessages = {
      skip: 'workflow dev hmr: skip',
      hot: 'workflow dev hmr: hot rebuild',
      full: 'workflow dev hmr: full rediscovery',
      idle: 'workflow dev hmr: idle',
    };
    const fetchWithTimeout = (pathname: string) => {
      if (!deploymentUrl) {
        return Promise.resolve();
      }

      return fetch(new URL(pathname, deploymentUrl), {
        signal: AbortSignal.timeout(PREWARM_FETCH_TIMEOUT_MS),
      });
    };

    const prewarm = async () => {
      // Pre-warm the app with bounded requests so cleanup hooks cannot hang.
      await Promise.all([
        fetchWithTimeout('/').catch(() => {}),
        fetchWithTimeout('/api/chat').catch(() => {}),
      ]);
    };
    const decodeDevServerLog = (content: Buffer) => {
      if (content.length >= 2 && content[0] === 0xff && content[1] === 0xfe) {
        return content.toString('utf16le');
      }

      const sample = content.subarray(0, Math.min(content.length, 200));
      const nullByteCount = sample.filter((byte) => byte === 0).length;
      return nullByteCount > sample.length / 4
        ? content.toString('utf16le')
        : content.toString('utf8');
    };
    const readDevServerLog = async (): Promise<string> => {
      if (!devServerLogPath) {
        return '';
      }
      return await fs
        .readFile(devServerLogPath)
        .then(decodeDevServerLog)
        .catch(() => '');
    };
    /**
     * Wait until the dev server's HMR pipeline is idle and no new HMR line
     * has appeared for a short window covering watcher latency and debounce.
     *
     * Rebuilds are serialized and can take multi-second on CI, so a write
     * from a previous case (or a teardown restore) can still be rebuilding
     * — or sitting in the queue — when the next exact-count window would
     * open. Draining here keeps those legitimate rebuild lines out of the
     * next window instead of failing it with over-counts.
     */
    const hmrQuiescenceQuietMs = 2_000;
    const waitForHmrQuiescence = async () => {
      if (!devServerLogPath || !shouldAssertDevHmrLogs) {
        return;
      }
      let lastHmrLogIndex = -1;
      let quietSince = Date.now();
      await pollUntil({
        description: 'dev server HMR pipeline to go quiescent',
        timeoutMs: hmrRediscoveryTimeoutMs,
        intervalMs: 250,
        check: async () => {
          const log = await readDevServerLog();
          const lastDecisionIndex = Math.max(
            log.lastIndexOf(hmrLogMessages.hot),
            log.lastIndexOf(hmrLogMessages.full),
            log.lastIndexOf(hmrLogMessages.skip)
          );
          const lastIdleIndex = log.lastIndexOf(hmrLogMessages.idle);
          const latestHmrLogIndex = Math.max(lastDecisionIndex, lastIdleIndex);
          if (latestHmrLogIndex !== lastHmrLogIndex) {
            lastHmrLogIndex = latestHmrLogIndex;
            quietSince = Date.now();
          }
          expect(lastIdleIndex).toBeGreaterThanOrEqual(lastDecisionIndex);
          expect(Date.now() - quietSince).toBeGreaterThanOrEqual(
            hmrQuiescenceQuietMs
          );
        },
      });
    };

    // Cursors open exact-count windows, so they only get taken once the
    // pipeline is drained — every call site writes after taking its cursor.
    const readDevServerLogCursor = async () => {
      if (!devServerLogPath || !shouldAssertDevHmrLogs) {
        return undefined;
      }
      await waitForHmrQuiescence();
      return (await readDevServerLog()).length;
    };
    const countLogMessage = (log: string, message: string) =>
      log.split(message).length - 1;
    type ExpectedHmrLogCount =
      | number
      | { kind: 'range'; min: number; max: number };
    type ExpectedHmrLogCounts = {
      skip?: ExpectedHmrLogCount;
      hot?: ExpectedHmrLogCount;
      full?: ExpectedHmrLogCount;
    };
    const expectLogCount = (
      actual: number,
      expected: ExpectedHmrLogCount | undefined
    ) => {
      if (expected === undefined || typeof expected === 'number') {
        expect(actual).toBe(expected ?? 0);
        return;
      }
      expect(actual).toBeGreaterThanOrEqual(expected.min);
      expect(actual).toBeLessThanOrEqual(expected.max);
    };
    const expectHmrLogCounts = async (
      cursor: number | undefined,
      expected: ExpectedHmrLogCounts
    ) => {
      if (cursor === undefined) {
        return;
      }
      await waitForHmrQuiescence();
      const log = (await readDevServerLog()).slice(cursor);
      expect(log).toContain(hmrLogMessages.idle);
      expectLogCount(countLogMessage(log, hmrLogMessages.skip), expected.skip);
      expectLogCount(countLogMessage(log, hmrLogMessages.hot), expected.hot);
      expectLogCount(countLogMessage(log, hmrLogMessages.full), expected.full);
    };

    const pollUntil = async ({
      description,
      check,
      timeoutMs = 25_000,
      intervalMs = 1_000,
    }: {
      description: string;
      check: () => Promise<void>;
      timeoutMs?: number;
      intervalMs?: number;
    }) => {
      const deadline = Date.now() + timeoutMs;
      let lastError: unknown = null;

      while (Date.now() < deadline) {
        try {
          await check();
          return;
        } catch (error) {
          lastError = error;
          await new Promise((res) => setTimeout(res, intervalMs));
        }
      }

      const lastErrorSuffix =
        lastError instanceof Error
          ? ` Last error: ${lastError.message}`
          : lastError
            ? ` Last error: ${String(lastError)}`
            : '';
      throw new Error(
        `Timed out after ${timeoutMs}ms waiting for ${description}.${lastErrorSuffix}`
      );
    };
    const waitForHmrReady = async () => {
      if (!devServerLogPath || !shouldAssertDevHmrLogs) {
        return;
      }
      await pollUntil({
        description: 'dev server HMR watcher to be ready',
        timeoutMs: 50_000,
        intervalMs: 250,
        check: async () => {
          expect(await readDevServerLog()).toContain('workflow dev hmr: ready');
        },
      });
    };
    const waitForGeneratedArtifactStability = async () => {
      await prewarm();
      let previous = await readGeneratedArtifactSnapshot();
      for (let i = 0; i < 5; i++) {
        await sleep(1_000);
        const next = await readGeneratedArtifactSnapshot();
        if (
          previous.stepMtimeMs === next.stepMtimeMs &&
          previous.workflowMtimeMs === next.workflowMtimeMs
        ) {
          return next;
        }
        previous = next;
      }
      return previous;
    };
    const expectGeneratedArtifactsUnchanged = async (
      before: Awaited<ReturnType<typeof readGeneratedArtifactSnapshot>>
    ) => {
      await prewarm();
      await sleep(3_000);
      const after = await readGeneratedArtifactSnapshot();
      expect(after.stepMtimeMs).toBe(before.stepMtimeMs);
      expect(after.workflowMtimeMs).toBe(before.workflowMtimeMs);
      return after;
    };

    beforeAll(async () => {
      await prewarm();
    }, CLEANUP_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      // Restore file contents before deleting any files. If a deletion races
      // ahead of an api-file restore, the dev server briefly sees an import
      // pointing at a missing module and fails compilation. On Windows that
      // failure can stick in Turbopack's generated workflow outputs, and every
      // subsequent step request returns 500.
      const toRestore = restoreFiles.filter((item) => item.content !== '');
      const toDelete = restoreFiles.filter((item) => item.content === '');
      // Captured before the delete so a file the dev server failed to forget
      // can be put back verbatim. See
      // `waitForDeletedFilesToLeaveStepRegistrations`.
      const deleted = await Promise.all(
        toDelete.map(async (item) => ({
          path: item.path,
          content: (await readFileIfExists(item.path)) ?? '',
        }))
      );
      try {
        await Promise.all(
          toRestore.map((item) => fs.writeFile(item.path, item.content))
        );
        if (toDelete.length > 0) {
          await prewarm();
        }
        await Promise.all(
          toDelete.map((item) => fs.rm(item.path, { force: true }))
        );
        await prewarm();
        // Runs before the directory removals below so a restored fixture still
        // finds the node_modules package it imports.
        await waitForDeletedFilesToLeaveStepRegistrations(deleted);
        await Promise.all(
          restoreDirectories.map((dir) =>
            fs.rm(dir, { recursive: true, force: true })
          )
        );
        await prewarm();
      } finally {
        restoreFiles.length = 0;
        restoreDirectories.length = 0;
      }
    }, CLEANUP_HOOK_TIMEOUT_MS);

    test.runIf(shouldRunNextFlowRouteHmrTests)(
      'should not rebuild workflows on Next page body-only change',
      { timeout: hmrTestTimeoutMs },
      async () => {
        await waitForHmrReady();

        const pageFile = path.join(appPath, 'app/page.tsx');
        const pageContent = await fs.readFile(pageFile, 'utf8');
        restoreFiles.push({ path: pageFile, content: pageContent });

        const snapshot = await waitForGeneratedArtifactStability();
        const logCursor = await readDevServerLogCursor();
        await fs.writeFile(
          pageFile,
          `${pageContent}
// workflow hmr body-only probe
`
        );

        await expectGeneratedArtifactsUnchanged(snapshot);
        await expectHmrLogCounts(logCursor, {
          skip: { kind: 'range', min: 1, max: 2 },
        });
      }
    );

    test.runIf(shouldRunNextFlowRouteHmrTests)(
      'should rediscover workflows on Next page directive change',
      { timeout: hmrTestTimeoutMs },
      async () => {
        await waitForHmrReady();

        const pageFile = path.join(appPath, 'app/page.tsx');
        const pageContent = await fs.readFile(pageFile, 'utf8');
        restoreFiles.push({ path: pageFile, content: pageContent });

        const logCursor = await readDevServerLogCursor();
        await fs.writeFile(
          pageFile,
          `${pageContent}

export async function hmrPageWorkflow() {
  'use workflow';
  return 'hmr page workflow';
}
`
        );

        await pollUntil({
          description: 'page-defined workflow to appear in manifest',
          timeoutMs: hmrRediscoveryTimeoutMs,
          intervalMs: 500,
          check: async () => {
            await prewarm();
            expect(await readManifestWorkflowFunctionNames()).toContain(
              'hmrPageWorkflow'
            );
          },
        });
        await expectHmrLogCounts(logCursor, {
          full: { kind: 'range', min: 1, max: 2 },
          skip: { kind: 'range', min: 0, max: 1 },
        });
      }
    );

    test.runIf(
      shouldRunNextFlowRouteHmrTests &&
        process.env.APP_NAME === 'nextjs-turbopack'
    )(
      'should rediscover workflows when a registry import changes',
      { timeout: 70_000 },
      async () => {
        await waitForHmrReady();

        const registryFile = path.join(appPath, '_workflows.ts');
        const registryFileContent = await fs.readFile(registryFile, 'utf8');
        restoreFiles.push({
          path: registryFile,
          content: registryFileContent,
        });

        const registryWithoutSimpleImport = registryFileContent
          .replace(
            /^import \* as workflow_1_simple from '\.\/workflows\/1_simple';$/m,
            "// import * as workflow_1_simple from './workflows/1_simple';"
          )
          .replace(
            /^ {2}'workflows\/1_simple\.ts': workflow_1_simple,$/m,
            "  // 'workflows/1_simple.ts': workflow_1_simple,"
          );
        expect(registryWithoutSimpleImport).not.toBe(registryFileContent);
        expect(registryWithoutSimpleImport).toContain(
          "// import * as workflow_1_simple from './workflows/1_simple';"
        );
        expect(registryWithoutSimpleImport).toContain(
          "// 'workflows/1_simple.ts': workflow_1_simple,"
        );

        await fs.writeFile(registryFile, registryWithoutSimpleImport);
        await pollUntil({
          description: 'registry import rediscovery to keep manifest readable',
          timeoutMs: 50_000,
          intervalMs: 500,
          check: async () => {
            await prewarm();
            expect(await readManifestWorkflowFunctionNames()).toContain(
              'simple'
            );
          },
        });
      }
    );

    test(
      'should rebuild on workflow change',
      {
        timeout: usesNextFlowRoute
          ? multiPhaseHmrTestTimeoutMs
          : hmrTestTimeoutMs,
      },
      async () => {
        if (usesNextFlowRoute) {
          await waitForHmrReady();
        }

        let workflowFile = path.join(appPath, workflowsDir, testWorkflowFile);
        let content = await fs.readFile(workflowFile, 'utf8');

        if (usesNextFlowRoute) {
          workflowFile = path.join(
            appPath,
            workflowsDir,
            'dev-test-workflow-change.ts'
          );
          const apiFile = path.join(appPath, finalConfig.apiFilePath);
          const apiFileContent = await fs.readFile(apiFile, 'utf8');
          restoreFiles.push({ path: apiFile, content: apiFileContent });
          restoreFiles.push({ path: workflowFile, content: '' });

          content = `export async function devTestWorkflowChangeBase() {
  'use workflow';
  return 'base';
}
`;
          await fs.writeFile(workflowFile, content);
          await fs.writeFile(
            apiFile,
            `import '${finalConfig.apiFileImportPath}/${workflowsDir}/dev-test-workflow-change';
${apiFileContent}`
          );
          await pollUntil({
            description: 'workflow-change fixture to appear in manifest',
            timeoutMs: hmrRediscoveryTimeoutMs,
            check: async () => {
              await prewarm();
              expect(await readManifestWorkflowFunctionNames()).toContain(
                'devTestWorkflowChangeBase'
              );
            },
          });
        }

        await fs.writeFile(
          workflowFile,
          `${content}

export async function myNewWorkflow() {
  'use workflow'
  return 'hello world'
}
`
        );
        if (!usesNextFlowRoute) {
          restoreFiles.push({ path: workflowFile, content });
        }

        await pollUntil({
          description: 'generated workflow to include myNewWorkflow',
          timeoutMs: usesNextFlowRoute ? hmrRediscoveryTimeoutMs : 25_000,
          check: async () => {
            if (usesNextFlowRoute) {
              await prewarm();
              const manifestFunctionNames =
                await readManifestWorkflowFunctionNames();
              expect(manifestFunctionNames).toContain('myNewWorkflow');
              return;
            }

            const workflowContent = await readGeneratedWorkflowOutput();
            expect(workflowContent).toContain('myNewWorkflow');
          },
        });
      }
    );

    test.runIf(!usesNextFlowRoute)(
      'should rebuild on step change',
      { timeout: 70_000 },
      async () => {
        if (usesNextFlowRoute) {
          await waitForHmrReady();
        }

        let stepFile = path.join(appPath, workflowsDir, testWorkflowFile);
        let content = await fs.readFile(stepFile, 'utf8');

        if (usesNextFlowRoute) {
          stepFile = path.join(
            appPath,
            workflowsDir,
            'dev-test-step-change.ts'
          );
          const apiFile = path.join(appPath, finalConfig.apiFilePath);
          const apiFileContent = await fs.readFile(apiFile, 'utf8');
          restoreFiles.push({ path: apiFile, content: apiFileContent });
          restoreFiles.push({ path: stepFile, content: '' });

          content = `export async function devTestStepChangeBase() {
  'use step';
  return 'base';
}
`;
          await fs.writeFile(stepFile, content);
          await fs.writeFile(
            apiFile,
            `import * as workflow_dev_test_step_change from '${finalConfig.apiFileImportPath}/${workflowsDir}/dev-test-step-change';
${apiFileContent.replace(
  'export const allWorkflows = {\n',
  `export const allWorkflows = {
  '${workflowsDir}/dev-test-step-change.ts': workflow_dev_test_step_change,
`
)}`
          );
          await pollUntil({
            description: 'step-change fixture to appear in manifest',
            timeoutMs: 50_000,
            check: async () => {
              await prewarm();
              expect(await readManifestStepFunctionNames()).toContain(
                'devTestStepChangeBase'
              );
            },
          });
        }

        await fs.writeFile(
          stepFile,
          `${content}

export async function myNewStep() {
  'use step'
  return 'hello world'
}
`
        );
        if (!usesNextFlowRoute) {
          restoreFiles.push({ path: stepFile, content });
        }
        await pollUntil({
          description: 'generated step outputs to include myNewStep',
          timeoutMs: usesNextFlowRoute ? 50_000 : 25_000,
          check: async () => {
            const stepRegistrationContent = await readFileIfExists(
              generatedStepRegistration
            );
            if (stepRegistrationContent?.includes('myNewStep')) {
              return;
            }

            // Next flow-route builders regenerate manifest.json on every
            // rebuild. The bundled file may not preserve function names as
            // plain text.
            if (usesNextFlowRoute) {
              await prewarm();
              const manifestFunctionNames =
                await readManifestStepFunctionNames();
              expect(manifestFunctionNames).toContain('myNewStep');
              return;
            }

            throw new Error('myNewStep not found in generated step outputs');
          },
        });
      }
    );

    test.runIf(process.env.APP_NAME === 'vite')(
      'should execute updated step logic after HMR',
      { timeout: 70_000 },
      async () => {
        assert(deploymentUrl);
        setupWorld(deploymentUrl);

        const workflowFile = path.join(appPath, workflowsDir, testWorkflowFile);
        const content = await fs.readFile(workflowFile, 'utf8');
        const before = 'before HMR';
        const after = 'after HMR';
        const fixture = `
export async function hmrWorkflow() {
  'use workflow';
  return hmrStep();
}

async function hmrStep() {
  'use step';
  return '${before}';
}
`;

        await fs.writeFile(workflowFile, content + fixture);
        restoreFiles.push({ path: workflowFile, content });

        await pollUntil({
          description: 'generated step output to include the HMR fixture',
          check: async () => {
            expect(
              await fs.readFile(generatedStepRegistration, 'utf8')
            ).toContain(before);
          },
        });

        const workflow = await getWorkflowMetadata(
          deploymentUrl,
          `workflows/${testWorkflowFile}`,
          'hmrWorkflow'
        );
        const runBefore = await start<[], string>(workflow, []);
        expect(await runBefore.returnValue).toBe(before);

        await fs.writeFile(
          workflowFile,
          (content + fixture).replace(before, after)
        );

        await pollUntil({
          description: 'generated step output to include the HMR update',
          check: async () => {
            expect(
              await fs.readFile(generatedStepRegistration, 'utf8')
            ).toContain(after);
          },
        });

        const runAfter = await start<[], string>(workflow, []);
        expect(await runAfter.returnValue).toBe(after);
      }
    );

    test(
      'should rebuild on adding workflow file',
      { timeout: hmrTestTimeoutMs },
      async () => {
        if (usesNextFlowRoute) {
          await waitForHmrReady();
        }

        const workflowFile = path.join(
          appPath,
          workflowsDir,
          'new-workflow.ts'
        );

        await fs.writeFile(
          workflowFile,
          `export async function newWorkflowFile() {
  'use workflow'
  return 'hello world'
}
`
        );
        restoreFiles.push({ path: workflowFile, content: '' });
        const apiFile = path.join(appPath, finalConfig.apiFilePath);

        const apiFileContent = await fs.readFile(apiFile, 'utf8');
        restoreFiles.push({ path: apiFile, content: apiFileContent });

        await fs.writeFile(
          apiFile,
          `import '${finalConfig.apiFileImportPath}/${workflowsDir}/new-workflow';
${apiFileContent}`
        );

        await pollUntil({
          description: 'generated workflow to include newWorkflowFile',
          timeoutMs: hmrRediscoveryTimeoutMs,
          check: async () => {
            if (usesNextFlowRoute) {
              const manifestJson = await fs.readFile(
                workflowManifestPath,
                'utf8'
              );
              const manifest = JSON.parse(manifestJson) as {
                workflows?: Record<string, Record<string, unknown>>;
              };
              expect(
                Object.values(manifest.workflows || {}).some((workflows) =>
                  Object.hasOwn(workflows, 'newWorkflowFile')
                )
              ).toBe(true);
              return;
            }

            await fetchWithTimeout('/api/chat');
            const workflowContent = await readGeneratedWorkflowOutput();
            expect(workflowContent).toContain('newWorkflowFile');
          },
        });
      }
    );

    test.runIf(process.env.APP_NAME === 'nextjs-turbopack')(
      'should not log source map warnings for workflow node_modules imports',
      { timeout: hmrTestTimeoutMs },
      async () => {
        const packageDir = path.join(
          appPath,
          'node_modules',
          SOURCE_MAP_FIXTURE_PACKAGE
        );
        const packageJsonPath = path.join(packageDir, 'package.json');
        const packageIndexPath = path.join(packageDir, 'index.js');
        const workflowFile = path.join(
          appPath,
          workflowsDir,
          'source-map-warning-fixture.ts'
        );
        const apiFile = path.join(appPath, finalConfig.apiFilePath);
        const apiFileContent = await fs.readFile(apiFile, 'utf8');

        await fs.mkdir(packageDir, { recursive: true });
        restoreDirectories.push(packageDir);
        await fs.writeFile(
          packageJsonPath,
          JSON.stringify(
            {
              name: SOURCE_MAP_FIXTURE_PACKAGE,
              version: '0.0.0',
              type: 'module',
              main: './index.js',
              types: './index.d.ts',
            },
            null,
            2
          )
        );
        await fs.writeFile(
          packageIndexPath,
          `export const sourceMapWarningFixtureValue = Symbol.for('workflow-serialize').description ?? 'workflow-serialize';
${SOURCE_MAP_COMMENT}
`
        );
        await fs.writeFile(
          path.join(packageDir, 'index.d.ts'),
          `export declare const sourceMapWarningFixtureValue: string;
`
        );
        await fs.writeFile(
          workflowFile,
          `import { sourceMapWarningFixtureValue } from '${SOURCE_MAP_FIXTURE_PACKAGE}';

async function readSourceMapWarningFixture() {
  'use step';
  return sourceMapWarningFixtureValue;
}

export async function sourceMapWarningFixtureWorkflow() {
  'use workflow';
  return readSourceMapWarningFixture();
}
`
        );
        restoreFiles.push({ path: workflowFile, content: '' });
        restoreFiles.push({ path: apiFile, content: apiFileContent });

        await fs.writeFile(
          apiFile,
          `import '${finalConfig.apiFileImportPath}/${workflowsDir}/source-map-warning-fixture';
${apiFileContent}`
        );

        await pollUntil({
          description:
            'generated workflow to include sourceMapWarningFixtureWorkflow',
          timeoutMs: hmrRediscoveryTimeoutMs,
          check: async () => {
            if (usesNextFlowRoute) {
              const manifestFunctionNames =
                await readManifestWorkflowFunctionNames();
              expect(manifestFunctionNames).toContain(
                'sourceMapWarningFixtureWorkflow'
              );
              return;
            }

            await fetchWithTimeout('/api/chat');
            const workflowContent = await readGeneratedWorkflowOutput();
            expect(workflowContent).toContain(
              'sourceMapWarningFixtureWorkflow'
            );
          },
        });

        if (devServerLogPath) {
          const log = await fs.readFile(devServerLogPath, 'utf8');
          expect(log).not.toContain(SOURCE_MAP_WARNING);
        }
      }
    );

    test.runIf(shouldRunNextFlowRouteHmrTests)(
      'should follow Next flow-route HMR rebuild rules for body-only changes',
      { timeout: flowRouteHmrFuzzTimeoutMs },
      async () => {
        assert(deploymentUrl);
        setupWorld(deploymentUrl);

        const apiFile = path.join(appPath, finalConfig.apiFilePath);
        const apiFileContent = await fs.readFile(apiFile, 'utf8');
        restoreFiles.push({ path: apiFile, content: apiFileContent });

        const files = {
          workflow: path.join(appPath, workflowsDir, 'hmr-fuzz-workflow.ts'),
          workflowHelper: path.join(
            appPath,
            workflowsDir,
            'hmr-fuzz-workflow-helper.ts'
          ),
          step: path.join(appPath, workflowsDir, 'hmr-fuzz-step.ts'),
          stepHelper: path.join(
            appPath,
            workflowsDir,
            'hmr-fuzz-step-helper.ts'
          ),
          sharedHelper: path.join(
            appPath,
            workflowsDir,
            'hmr-fuzz-shared-helper.ts'
          ),
          serde: path.join(appPath, workflowsDir, 'hmr-fuzz-serde.ts'),
          importHelper: path.join(
            appPath,
            workflowsDir,
            'hmr-fuzz-import-helper.ts'
          ),
          buildInput: path.join(
            appPath,
            workflowsDir,
            'hmr-fuzz-build-input.json'
          ),
          addedWorkflow: path.join(
            appPath,
            workflowsDir,
            'hmr-fuzz-added-workflow.ts'
          ),
          unrelated: path.join(appPath, workflowsDir, 'hmr-fuzz-unrelated.ts'),
        };
        for (const file of Object.values(files)) {
          restoreFiles.push({ path: file, content: '' });
        }

        await waitForHmrReady();

        const writeFuzzSources = async (iteration: number) => {
          await Promise.all([
            fs.writeFile(
              files.workflow,
              `import { HmrFuzzBox, hmrFuzzSerdeStep } from './hmr-fuzz-serde';
import { hmrFuzzSharedHelper } from './hmr-fuzz-shared-helper';
import { hmrFuzzStep } from './hmr-fuzz-step';
import { hmrFuzzWorkflowHelper } from './hmr-fuzz-workflow-helper';

export async function hmrFuzzWorkflow() {
  'use workflow';
  const stepValue = await hmrFuzzStep();
  const workflowValue = hmrFuzzWorkflowHelper(
    new HmrFuzzBox(hmrFuzzSharedHelper('workflow-${iteration}'))
  );
  const roundTripped = await hmrFuzzSerdeStep(new HmrFuzzBox(workflowValue));
  return { stepValue, workflowValue: roundTripped.label };
}
`
            ),
            fs.writeFile(
              files.workflowHelper,
              `import { HmrFuzzBox } from './hmr-fuzz-serde';

export function hmrFuzzWorkflowHelper(value: HmrFuzzBox) {
  return value.label + '-workflow-helper-${iteration}';
}
`
            ),
            fs.writeFile(
              files.step,
              `import { hmrFuzzSharedHelper } from './hmr-fuzz-shared-helper';
import { hmrFuzzStepHelper } from './hmr-fuzz-step-helper';

export async function hmrFuzzStep() {
  'use step';
  return hmrFuzzSharedHelper(hmrFuzzStepHelper()) + '-step-${iteration}';
}
`
            ),
            fs.writeFile(
              files.stepHelper,
              `export function hmrFuzzStepHelper() {
  return 'step-helper-${iteration}';
}
`
            ),
            fs.writeFile(
              files.sharedHelper,
              `export function hmrFuzzSharedHelper(value: string) {
  return value + '-shared-${iteration}';
}
`
            ),
            fs.writeFile(
              files.serde,
              `export class HmrFuzzBox {
  static classId = 'HmrFuzzBox';

  constructor(public label: string) {}

  static [Symbol.for('workflow-serialize')](value: HmrFuzzBox) {
    return { label: value.label + '-serde-${iteration}' };
  }

  static [Symbol.for('workflow-deserialize')](value: { label: string }) {
    return new HmrFuzzBox(value.label);
  }
}

export async function hmrFuzzSerdeStep(value: HmrFuzzBox) {
  'use step';
  return value;
}
`
            ),
            fs.writeFile(
              files.importHelper,
              "export const hmrFuzzImportedValue = 'imported-stable';\n"
            ),
          ]);
        };

        await writeFuzzSources(0);
        await fs.writeFile(
          apiFile,
          `import '${finalConfig.apiFileImportPath}/${workflowsDir}/hmr-fuzz-step';
import '${finalConfig.apiFileImportPath}/${workflowsDir}/hmr-fuzz-workflow';
${apiFileContent}`
        );

        await pollUntil({
          description: 'HMR fuzz fixture to appear in the Next manifest',
          timeoutMs: flowRouteHmrRediscoveryTimeoutMs,
          check: async () => {
            await prewarm();
            expect(await readManifestStepFunctionNames()).toContain(
              'hmrFuzzStep'
            );
            expect(await readManifestWorkflowFunctionNames()).toContain(
              'hmrFuzzWorkflow'
            );
          },
        });

        let workflow:
          | Awaited<ReturnType<typeof getWorkflowMetadata>>
          | undefined;
        await pollUntil({
          description: 'HMR fuzz workflow metadata to be readable',
          timeoutMs: 50_000,
          intervalMs: 500,
          check: async () => {
            workflow = await getWorkflowMetadata(
              deploymentUrl,
              `${workflowsDir}/hmr-fuzz-workflow.ts`,
              'hmrFuzzWorkflow'
            );
          },
        });
        assert(workflow);
        await waitForHmrQuiescence();
        const runWorkflow = async () => {
          const run = await start<
            [],
            { stepValue: string; workflowValue: string }
          >(workflow, []);
          return await run.returnValue;
        };
        type ExpectedWorkflowResult =
          | { kind: 'step'; value: string }
          | { kind: 'workflow'; value: string }
          | { kind: 'both'; stepValue: string; workflowValue: string };
        const expectWorkflowResult = async ({
          description,
          expected,
        }: {
          description: string;
          expected: ExpectedWorkflowResult;
        }) => {
          await pollUntil({
            description,
            timeoutMs: 90_000,
            intervalMs: 500,
            check: async () => {
              const result = await runWorkflow();
              switch (expected.kind) {
                case 'step':
                  expect(result.stepValue).toContain(expected.value);
                  return;
                case 'workflow':
                  expect(result.workflowValue).toContain(expected.value);
                  return;
                case 'both':
                  expect(result.stepValue).toContain(expected.stepValue);
                  expect(result.workflowValue).toContain(
                    expected.workflowValue
                  );
                  return;
                default:
                  expected satisfies never;
                  throw new Error('Unknown workflow result expectation');
              }
            },
          });
        };

        let snapshot = await waitForGeneratedArtifactStability();
        const expectedHotRebuild: ExpectedHmrLogCounts = {
          hot: { kind: 'range', min: 1, max: 2 },
          skip: { kind: 'range', min: 0, max: 1 },
        };
        const cases = [
          {
            file: files.step,
            kind: 'step',
            expectedLogCounts: expectedHotRebuild,
            expectedResult: (iteration: number) =>
              ({
                kind: 'step',
                value: `step-only-${iteration}`,
              }) satisfies ExpectedWorkflowResult,
            source: (
              iteration: number
            ) => `import { hmrFuzzSharedHelper } from './hmr-fuzz-shared-helper';
import { hmrFuzzStepHelper } from './hmr-fuzz-step-helper';

export async function hmrFuzzStep() {
  'use step';
  return hmrFuzzSharedHelper(hmrFuzzStepHelper()) + '-step-only-${iteration}';
}
`,
          },
          {
            file: files.stepHelper,
            kind: 'workflow',
            expectedLogCounts: expectedHotRebuild,
            expectedResult: (iteration: number) =>
              ({
                kind: 'step',
                value: `step-helper-only-${iteration}`,
              }) satisfies ExpectedWorkflowResult,
            source: (
              iteration: number
            ) => `export function hmrFuzzStepHelper() {
  return 'step-helper-only-${iteration}';
}
`,
          },
          {
            file: files.workflow,
            kind: 'workflow',
            expectedLogCounts: expectedHotRebuild,
            expectedResult: (iteration: number) =>
              ({
                kind: 'workflow',
                value: `workflow-body-${iteration}`,
              }) satisfies ExpectedWorkflowResult,
            source: (
              iteration: number
            ) => `import { HmrFuzzBox, hmrFuzzSerdeStep } from './hmr-fuzz-serde';
import { hmrFuzzSharedHelper } from './hmr-fuzz-shared-helper';
import { hmrFuzzStep } from './hmr-fuzz-step';
import { hmrFuzzWorkflowHelper } from './hmr-fuzz-workflow-helper';

export async function hmrFuzzWorkflow() {
  'use workflow';
  const stepValue = await hmrFuzzStep();
  const workflowValue = hmrFuzzWorkflowHelper(
    new HmrFuzzBox(hmrFuzzSharedHelper('workflow-body-${iteration}'))
  );
  const roundTripped = await hmrFuzzSerdeStep(new HmrFuzzBox(workflowValue));
  return { stepValue, workflowValue: roundTripped.label };
}
`,
          },
          {
            file: files.workflowHelper,
            kind: 'workflow',
            expectedLogCounts: expectedHotRebuild,
            expectedResult: (iteration: number) =>
              ({
                kind: 'workflow',
                value: `workflow-helper-body-${iteration}`,
              }) satisfies ExpectedWorkflowResult,
            source: (
              iteration: number
            ) => `import { HmrFuzzBox } from './hmr-fuzz-serde';

export function hmrFuzzWorkflowHelper(value: HmrFuzzBox) {
  return value.label + '-workflow-helper-body-${iteration}';
}
`,
          },
          {
            file: files.sharedHelper,
            kind: 'workflow',
            expectedLogCounts: expectedHotRebuild,
            expectedResult: (iteration: number) =>
              ({
                kind: 'both',
                stepValue: `shared-body-${iteration}`,
                workflowValue: `shared-body-${iteration}`,
              }) satisfies ExpectedWorkflowResult,
            source: (
              iteration: number
            ) => `export function hmrFuzzSharedHelper(value: string) {
  return value + '-shared-body-${iteration}';
}
`,
          },
          {
            file: files.serde,
            kind: 'serde',
            expectedLogCounts: expectedHotRebuild,
            expectedResult: (iteration: number) =>
              ({
                kind: 'workflow',
                value: `serde-body-${iteration}`,
              }) satisfies ExpectedWorkflowResult,
            source: (iteration: number) => `export class HmrFuzzBox {
  static classId = 'HmrFuzzBox';

  constructor(public label: string) {}

  static [Symbol.for('workflow-serialize')](value: HmrFuzzBox) {
    return { label: value.label + '-serde-body-${iteration}' };
  }

  static [Symbol.for('workflow-deserialize')](value: { label: string }) {
    return new HmrFuzzBox(value.label);
  }
}

export async function hmrFuzzSerdeStep(value: HmrFuzzBox) {
  'use step';
  return value;
}
`,
          },
        ] as const;
        for (let index = 0; index < cases.length; index++) {
          const iteration = index + 1;
          const testCase = cases[index];
          const previousSnapshot = snapshot;
          const logCursor = await readDevServerLogCursor();
          await fs.writeFile(testCase.file, testCase.source(iteration));

          await expectWorkflowResult({
            description: `${testCase.kind} HMR update to affect workflow execution`,
            expected: testCase.expectedResult(iteration),
          });

          if (testCase.kind === 'skip') {
            await expectHmrLogCounts(logCursor, testCase.expectedLogCounts);
            snapshot = await waitForGeneratedArtifactStability();
            continue;
          }

          snapshot = await waitForGeneratedArtifactStability();
          if (testCase.kind === 'workflow' || testCase.kind === 'step') {
            expect(snapshot.stepMtimeMs).toBe(previousSnapshot.stepMtimeMs);
          } else {
            expect(snapshot.stepMtimeMs).toBeGreaterThanOrEqual(
              previousSnapshot.stepMtimeMs
            );
          }
          await expectHmrLogCounts(logCursor, testCase.expectedLogCounts);
        }

        const expectedFullRediscovery: ExpectedHmrLogCounts = {
          full: { kind: 'range', min: 1, max: 3 },
        };
        const rebuildCases = [
          {
            description: 'workflow import graph change',
            expectedLogCounts: expectedFullRediscovery,
            write: async () => {
              await fs.writeFile(
                files.workflow,
                `import { hmrFuzzImportedValue } from './hmr-fuzz-import-helper';
import { HmrFuzzBox, hmrFuzzSerdeStep } from './hmr-fuzz-serde';
import { hmrFuzzSharedHelper } from './hmr-fuzz-shared-helper';
import { hmrFuzzStep } from './hmr-fuzz-step';
import { hmrFuzzWorkflowHelper } from './hmr-fuzz-workflow-helper';

export async function hmrFuzzWorkflow() {
  'use workflow';
  const stepValue = await hmrFuzzStep();
  const workflowValue = hmrFuzzWorkflowHelper(
    new HmrFuzzBox(hmrFuzzSharedHelper(hmrFuzzImportedValue))
  );
  const roundTripped = await hmrFuzzSerdeStep(new HmrFuzzBox(workflowValue));
  return { stepValue, workflowValue: roundTripped.label };
}
`
              );
            },
            assert: async () => {
              await expectWorkflowResult({
                description:
                  'workflow import graph full rediscovery to affect execution',
                expected: { kind: 'workflow', value: 'imported-stable' },
              });
            },
          },
          {
            description: 'new workflow dependency body change',
            expectedLogCounts: expectedHotRebuild,
            write: async () => {
              await fs.writeFile(
                files.importHelper,
                "export const hmrFuzzImportedValue = 'imported-updated';\n"
              );
            },
            assert: async () => {
              await expectWorkflowResult({
                description:
                  'new workflow dependency body change to affect execution',
                expected: { kind: 'workflow', value: 'imported-updated' },
              });
            },
          },
          {
            description: 'non-source workflow dependency added',
            expectedLogCounts: expectedFullRediscovery,
            write: async () => {
              await fs.writeFile(
                files.buildInput,
                JSON.stringify({ value: 'json-stable' })
              );
              await fs.writeFile(
                files.workflow,
                `import hmrFuzzBuildInput from './hmr-fuzz-build-input.json';
import { HmrFuzzBox, hmrFuzzSerdeStep } from './hmr-fuzz-serde';
import { hmrFuzzSharedHelper } from './hmr-fuzz-shared-helper';
import { hmrFuzzStep } from './hmr-fuzz-step';
import { hmrFuzzWorkflowHelper } from './hmr-fuzz-workflow-helper';

export async function hmrFuzzWorkflow() {
  'use workflow';
  const stepValue = await hmrFuzzStep();
  const workflowValue = hmrFuzzWorkflowHelper(
    new HmrFuzzBox(hmrFuzzSharedHelper(hmrFuzzBuildInput.value))
  );
  const roundTripped = await hmrFuzzSerdeStep(new HmrFuzzBox(workflowValue));
  return { stepValue, workflowValue: roundTripped.label };
}
`
              );
            },
            assert: async () => {
              await expectWorkflowResult({
                description:
                  'non-source dependency rediscovery to affect execution',
                expected: { kind: 'workflow', value: 'json-stable' },
              });
            },
          },
          {
            description: 'non-source workflow dependency body change',
            expectedLogCounts: expectedFullRediscovery,
            write: async () => {
              await fs.writeFile(
                files.buildInput,
                JSON.stringify({ value: 'json-updated' })
              );
            },
            assert: async () => {
              await expectWorkflowResult({
                description:
                  'non-source dependency body change to affect execution',
                expected: { kind: 'workflow', value: 'json-updated' },
              });
            },
          },
          {
            description: 'step definition added',
            expectedLogCounts: expectedHotRebuild,
            write: async (iteration: number) => {
              await fs.writeFile(
                files.step,
                `import { hmrFuzzSharedHelper } from './hmr-fuzz-shared-helper';
import { hmrFuzzStepHelper } from './hmr-fuzz-step-helper';

export async function hmrFuzzStep() {
  'use step';
  return hmrFuzzSharedHelper(hmrFuzzStepHelper()) + '-step-full-${iteration}';
}

export async function hmrFuzzAddedStep() {
  'use step';
  return 'added-step-${iteration}';
}
`
              );
            },
            assert: async () => {
              await pollUntil({
                description: 'added step definition to appear in manifest',
                timeoutMs: flowRouteHmrRediscoveryTimeoutMs,
                intervalMs: 500,
                check: async () => {
                  await prewarm();
                  expect(await readManifestStepFunctionNames()).toContain(
                    'hmrFuzzAddedStep'
                  );
                },
              });
            },
          },
          {
            description: 'workflow definition added',
            expectedLogCounts: expectedHotRebuild,
            write: async (iteration: number) => {
              await fs.writeFile(
                files.workflow,
                `import hmrFuzzBuildInput from './hmr-fuzz-build-input.json';
import { HmrFuzzBox, hmrFuzzSerdeStep } from './hmr-fuzz-serde';
import { hmrFuzzSharedHelper } from './hmr-fuzz-shared-helper';
import { hmrFuzzStep } from './hmr-fuzz-step';
import { hmrFuzzWorkflowHelper } from './hmr-fuzz-workflow-helper';

export async function hmrFuzzWorkflow() {
  'use workflow';
  const stepValue = await hmrFuzzStep();
  const workflowValue = hmrFuzzWorkflowHelper(
    new HmrFuzzBox(hmrFuzzSharedHelper(hmrFuzzBuildInput.value))
  );
  const roundTripped = await hmrFuzzSerdeStep(new HmrFuzzBox(workflowValue));
  return { stepValue, workflowValue: roundTripped.label };
}

export async function hmrFuzzAddedWorkflow() {
  'use workflow';
  return 'added-workflow-${iteration}';
}
`
              );
            },
            assert: async () => {
              await pollUntil({
                description: 'added workflow definition to appear in manifest',
                timeoutMs: flowRouteHmrRediscoveryTimeoutMs,
                intervalMs: 500,
                check: async () => {
                  await prewarm();
                  expect(await readManifestWorkflowFunctionNames()).toContain(
                    'hmrFuzzAddedWorkflow'
                  );
                },
              });
            },
          },
          {
            description: 'workflow file added through API import',
            expectedLogCounts: expectedFullRediscovery,
            write: async (iteration: number) => {
              await fs.writeFile(
                files.addedWorkflow,
                `export async function hmrFuzzAddedFileWorkflow() {
  'use workflow';
  return 'added-file-workflow-${iteration}';
}
`
              );
              await fs.writeFile(
                apiFile,
                `import '${finalConfig.apiFileImportPath}/${workflowsDir}/hmr-fuzz-added-workflow';
import '${finalConfig.apiFileImportPath}/${workflowsDir}/hmr-fuzz-step';
import '${finalConfig.apiFileImportPath}/${workflowsDir}/hmr-fuzz-workflow';
${apiFileContent}`
              );
            },
            assert: async () => {
              await pollUntil({
                description: 'added workflow file to appear in manifest',
                timeoutMs: flowRouteHmrRediscoveryTimeoutMs,
                intervalMs: 500,
                check: async () => {
                  await prewarm();
                  expect(await readManifestWorkflowFunctionNames()).toContain(
                    'hmrFuzzAddedFileWorkflow'
                  );
                },
              });
            },
          },
          {
            description: 'workflow file removed from API import',
            expectedLogCounts: {
              skip: { kind: 'range', min: 0, max: 1 },
              full: { kind: 'range', min: 1, max: 2 },
            },
            write: async () => {
              await fs.rm(files.addedWorkflow, { force: true });
              await fs.writeFile(
                apiFile,
                `import '${finalConfig.apiFileImportPath}/${workflowsDir}/hmr-fuzz-step';
import '${finalConfig.apiFileImportPath}/${workflowsDir}/hmr-fuzz-workflow';
${apiFileContent}`
              );
            },
            assert: async () => {
              await pollUntil({
                description: 'removed workflow file to disappear from manifest',
                timeoutMs: flowRouteHmrRediscoveryTimeoutMs,
                intervalMs: 500,
                check: async () => {
                  await prewarm();
                  expect(
                    await readManifestWorkflowFunctionNames()
                  ).not.toContain('hmrFuzzAddedFileWorkflow');
                },
              });
            },
          },
        ] as const;

        for (let index = 0; index < rebuildCases.length; index++) {
          const rebuildCase = rebuildCases[index];
          const logCursor = await readDevServerLogCursor();
          await rebuildCase.write(index + 1);
          await rebuildCase.assert();
          await expectHmrLogCounts(logCursor, rebuildCase.expectedLogCounts);
          snapshot = await waitForGeneratedArtifactStability();
        }

        const unrelatedLogCursor = await readDevServerLogCursor();
        await fs.writeFile(files.unrelated, 'export const unrelated = true;\n');
        snapshot = await expectGeneratedArtifactsUnchanged(snapshot);
        await expectHmrLogCounts(unrelatedLogCursor, expectedFullRediscovery);

        const unrelatedRemovalLogCursor = await readDevServerLogCursor();
        await fs.unlink(files.unrelated);
        snapshot = await expectGeneratedArtifactsUnchanged(snapshot);
        await expectHmrLogCounts(
          unrelatedRemovalLogCursor,
          expectedFullRediscovery
        );
      }
    );
  });
}

// Run tests with environment-based config if this file is executed directly
if (process.env.DEV_TEST_CONFIG) {
  createDevTests();
}
