import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, assert, beforeAll, describe, expect, test } from 'vitest';
import { start } from '../src/runtime';
import { getWorkbenchAppPath, getWorkflowMetadata, setupWorld } from './utils';

export interface DevTestConfig {
  generatedStepPath: string;
  generatedWorkflowPath: string;
  apiFilePath: string;
  apiFileImportPath: string;
  canary?: boolean;
  /** Whether the app emits deferred step copy files during dev. */
  supportsDeferredStepCopies?: boolean;
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
    // The afterEach cleanup can issue two *sequential* prewarms (before and
    // after deleting an added file) while the dev server is mid-rebuild — the
    // teardown of a test that added a workflow file and edited an import is
    // exactly when both rebuild and respond slowly. Its budget must therefore
    // exceed 2× PREWARM_FETCH_TIMEOUT_MS (plus file IO) with headroom, or it
    // trips vitest's 10s default hook timeout. The bounded fetches mean this
    // can't hang indefinitely, so a generous budget is safe.
    const CLEANUP_HOOK_TIMEOUT_MS = PREWARM_FETCH_TIMEOUT_MS * 4;
    const appPath = getWorkbenchAppPath();
    const deploymentUrl = process.env.DEPLOYMENT_URL;
    const generatedStep = path.join(appPath, finalConfig.generatedStepPath);
    const generatedWorkflow = path.join(
      appPath,
      finalConfig.generatedWorkflowPath
    );
    const testWorkflowFile = finalConfig.testWorkflowFile ?? '3_streams.ts';
    const workflowsDir = finalConfig.workflowsDir ?? 'workflows';
    const supportsDeferredStepCopies =
      finalConfig.supportsDeferredStepCopies ??
      generatedStep.includes(
        path.join('.well-known', 'workflow', 'v1', 'step', 'route.js')
      );
    const restoreFiles: Array<{ path: string; content: string }> = [];

    const fetchWithTimeout = (pathname: string) => {
      if (!deploymentUrl) {
        return Promise.resolve();
      }

      return fetch(new URL(pathname, deploymentUrl), {
        signal: AbortSignal.timeout(PREWARM_FETCH_TIMEOUT_MS),
      });
    };

    const triggerWorkflowRun = async (
      workflowName: string,
      args: unknown[] = []
    ) => {
      if (!deploymentUrl) {
        return;
      }

      const response = await fetch(
        new URL('/api/workflows/start', deploymentUrl),
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            workflowName,
            args,
          }),
          signal: AbortSignal.timeout(PREWARM_FETCH_TIMEOUT_MS),
        }
      );

      if (!response.ok) {
        throw new Error(
          `Failed to trigger workflow "${workflowName}": ${response.status}`
        );
      }
    };

    const prewarm = async () => {
      // Pre-warm the app with bounded requests so cleanup hooks cannot hang.
      await Promise.all([
        fetchWithTimeout('/').catch(() => {}),
        fetchWithTimeout('/api/chat').catch(() => {}),
        fetchWithTimeout('/.well-known/workflow/v1/flow?__health').catch(
          () => {}
        ),
        fetchWithTimeout('/.well-known/workflow/v1/step?__health').catch(
          () => {}
        ),
      ]);
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

    beforeAll(async () => {
      await prewarm();
    }, CLEANUP_HOOK_TIMEOUT_MS);

    afterEach(async () => {
      // Restore file contents before clearing any added files. Dev servers can
      // keep generated imports alive briefly after a rebuild. Next's generated
      // step route imports deferred copies, so added workflow files need to keep
      // their real contents until shutdown. Other builders can use empty
      // placeholders to drop workflow directives while avoiding missing imports.
      const toRestore = restoreFiles.filter((item) => item.content !== '');
      const toClear = restoreFiles.filter((item) => item.content === '');
      await Promise.all(
        toRestore.map((item) => fs.writeFile(item.path, item.content))
      );
      if (toClear.length > 0) {
        await prewarm();
        if (!supportsDeferredStepCopies) {
          await Promise.all(toClear.map((item) => fs.writeFile(item.path, '')));
          await prewarm();
        }
      }
      restoreFiles.length = 0;
    }, CLEANUP_HOOK_TIMEOUT_MS);

    test('should rebuild on workflow change', { timeout: 30_000 }, async () => {
      const workflowFile = path.join(appPath, workflowsDir, testWorkflowFile);

      const content = await fs.readFile(workflowFile, 'utf8');

      await fs.writeFile(
        workflowFile,
        `${content}

export async function myNewWorkflow() {
  'use workflow'
  return 'hello world'
}
`
      );
      restoreFiles.push({ path: workflowFile, content });

      await pollUntil({
        description: 'generated workflow to include myNewWorkflow',
        check: async () => {
          const workflowContent = await fs.readFile(generatedWorkflow, 'utf8');
          expect(workflowContent).toContain('myNewWorkflow');
        },
      });
    });

    test('should rebuild on step change', { timeout: 30_000 }, async () => {
      const stepFile = path.join(appPath, workflowsDir, testWorkflowFile);

      const content = await fs.readFile(stepFile, 'utf8');

      await fs.writeFile(
        stepFile,
        `${content}

export async function myNewStep() {
  'use step'
  return 'hello world'
}
`
      );
      restoreFiles.push({ path: stepFile, content });
      const copiedStepDir = path.join(
        path.dirname(generatedStep),
        '__workflow_step_files__'
      );

      await pollUntil({
        description: 'generated step outputs to include myNewStep',
        check: async () => {
          const stepRouteContent = await fs.readFile(generatedStep, 'utf8');
          if (stepRouteContent.includes('myNewStep')) {
            return;
          }
          if (!supportsDeferredStepCopies) {
            expect(stepRouteContent).toContain('myNewStep');
            return;
          }

          const copiedStepFileNames = await fs.readdir(copiedStepDir);
          const copiedStepContents = await Promise.all(
            copiedStepFileNames.map(async (copiedStepFileName) => {
              const copiedStepFilePath = path.join(
                copiedStepDir,
                copiedStepFileName
              );
              const copiedStepStats = await fs.stat(copiedStepFilePath);
              if (!copiedStepStats.isFile()) {
                return '';
              }
              return await fs.readFile(copiedStepFilePath, 'utf8');
            })
          );
          expect(
            copiedStepContents.some((content) => content.includes('myNewStep'))
          ).toBe(true);
        },
      });
    });

    test.skipIf(!supportsDeferredStepCopies)(
      'should rebuild on imported step dependency change',
      { timeout: 60_000 },
      async () => {
        const importedStepFile = path.join(
          appPath,
          workflowsDir,
          '_imported_step_only.ts'
        );
        const content = await fs.readFile(importedStepFile, 'utf8');
        const marker = 'importedStepOnlyHotReloadMarker';

        await fs.writeFile(
          importedStepFile,
          `${content}

export async function ${marker}() {
  'use step'
  return 'updated'
}
`
        );
        restoreFiles.push({ path: importedStepFile, content });

        const apiFile = path.join(appPath, finalConfig.apiFilePath);
        const apiFileContent = await fs.readFile(apiFile, 'utf8');
        const copiedStepDir = path.join(
          path.dirname(generatedStep),
          '__workflow_step_files__'
        );

        await pollUntil({
          description:
            'copied deferred step files to include imported step hot-reload marker',
          timeoutMs: 50_000,
          check: async () => {
            try {
              await triggerWorkflowRun('importedStepOnlyWorkflow');
            } catch (error) {
              // Turbopack on Windows occasionally caches a stale resolver
              // failure (e.g. `Could not parse module
              // '@workflow/core/dist/runtime/start.js'`) after an HMR
              // cascade and returns 500 to every request until something
              // invalidates its cache. Rewriting the api file is enough to
              // force a fresh resolve on the next request, so we treat the
              // 500 as transient and keep polling instead of bailing out.
              await fs.writeFile(apiFile, apiFileContent);
              throw error;
            }
            const copiedStepFileNames = await fs.readdir(copiedStepDir);
            const copiedStepContents = await Promise.all(
              copiedStepFileNames.map(async (copiedStepFileName) => {
                const copiedStepFilePath = path.join(
                  copiedStepDir,
                  copiedStepFileName
                );
                const copiedStepStats = await fs.stat(copiedStepFilePath);
                if (!copiedStepStats.isFile()) {
                  return '';
                }
                return await fs.readFile(copiedStepFilePath, 'utf8');
              })
            );
            expect(
              copiedStepContents.some((copiedStepContent) =>
                copiedStepContent.includes(marker)
              )
            ).toBe(true);
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
            expect(await fs.readFile(generatedStep, 'utf8')).toContain(before);
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
            expect(await fs.readFile(generatedStep, 'utf8')).toContain(after);
          },
        });

        const runAfter = await start<[], string>(workflow, []);
        expect(await runAfter.returnValue).toBe(after);
      }
    );

    test(
      'should rebuild on adding workflow file',
      {
        timeout: 60_000,
      },
      async () => {
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
          timeoutMs: 50_000,
          check: async () => {
            await fetchWithTimeout('/api/chat');
            const workflowContent = await fs.readFile(
              generatedWorkflow,
              'utf8'
            );
            expect(workflowContent).toContain('newWorkflowFile');
          },
        });
      }
    );

    test.skipIf(!supportsDeferredStepCopies)(
      'should include steps discovered from workflow imports',
      { timeout: 60_000 },
      async () => {
        const workflowFile = path.join(
          appPath,
          workflowsDir,
          'discovered-via-workflow.ts'
        );
        const stepFile = path.join(
          appPath,
          workflowsDir,
          'discovered-via-workflow-step.ts'
        );

        await fs.writeFile(
          workflowFile,
          `'use workflow';
import { discoveredViaWorkflowStep } from './discovered-via-workflow-step';

export async function discoveredViaWorkflow() {
  await discoveredViaWorkflowStep();
  return 'ok';
}
`
        );
        await fs.writeFile(
          stepFile,
          `'use step';

export async function discoveredViaWorkflowStep() {
  return 'ok';
}
`
        );
        restoreFiles.push({ path: workflowFile, content: '' });
        restoreFiles.push({ path: stepFile, content: '' });

        const apiFile = path.join(appPath, finalConfig.apiFilePath);
        const apiFileContent = await fs.readFile(apiFile, 'utf8');
        restoreFiles.push({ path: apiFile, content: apiFileContent });

        await fs.writeFile(
          apiFile,
          `import '${finalConfig.apiFileImportPath}/${workflowsDir}/discovered-via-workflow';
${apiFileContent}`
        );

        const copiedStepDir = path.join(
          path.dirname(generatedStep),
          '__workflow_step_files__'
        );

        await pollUntil({
          description:
            'copied deferred step files to include discoveredViaWorkflowStep',
          timeoutMs: 25_000,
          check: async () => {
            await fetchWithTimeout('/api/chat');
            const copiedStepFileNames = await fs.readdir(copiedStepDir);
            const copiedStepContents = await Promise.all(
              copiedStepFileNames.map(async (copiedStepFileName) => {
                const copiedStepFilePath = path.join(
                  copiedStepDir,
                  copiedStepFileName
                );
                const copiedStepStats = await fs.stat(copiedStepFilePath);
                if (!copiedStepStats.isFile()) {
                  return '';
                }
                return await fs.readFile(copiedStepFilePath, 'utf8');
              })
            );
            expect(
              copiedStepContents.some((content) =>
                content.includes('discoveredViaWorkflowStep')
              )
            ).toBe(true);
          },
        });
      }
    );

    test.runIf(process.env.APP_NAME === 'nextjs-turbopack')(
      'should not log source map warnings for workflow node_modules imports',
      { timeout: 70_000 },
      async () => {
        const packageDir = path.join(
          appPath,
          'node_modules',
          SOURCE_MAP_FIXTURE_PACKAGE
        );
        const workflowFile = path.join(
          appPath,
          workflowsDir,
          'source-map-warning-fixture.ts'
        );
        const apiFile = path.join(appPath, finalConfig.apiFilePath);
        const apiFileContent = await fs.readFile(apiFile, 'utf8');

        await fs.mkdir(packageDir, { recursive: true });
        // The generated dev output can retain this import until the server
        // shuts down, including while the full E2E suite runs after this file.
        // Keep the ignored node_modules fixture available for that lifetime.
        await fs.writeFile(
          path.join(packageDir, 'package.json'),
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
          path.join(packageDir, 'index.js'),
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
          timeoutMs: 50_000,
          check: async () => {
            await fetchWithTimeout('/api/chat');
            const workflowContent = await fs.readFile(
              generatedWorkflow,
              'utf8'
            );
            expect(workflowContent).toContain(
              'sourceMapWarningFixtureWorkflow'
            );
          },
        });

        const devServerLogPath = process.env.DEV_SERVER_LOG_PATH;
        if (devServerLogPath) {
          const log = await fs.readFile(devServerLogPath, 'utf8');
          expect(log).not.toContain(SOURCE_MAP_WARNING);
        }
      }
    );
  });
}

// Run tests with environment-based config if this file is executed directly
if (process.env.DEV_TEST_CONFIG) {
  createDevTests();
}
