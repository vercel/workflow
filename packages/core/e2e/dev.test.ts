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
    const usesNextFlowRoute = generatedWorkflow.includes(
      path.join('app', '.well-known', 'workflow', 'v1', 'flow', 'route.js')
    );
    const workflowManifestPath = path.join(
      appPath,
      'app/.well-known/workflow/v1/manifest.json'
    );
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
      // Restore file contents before deleting any files. If a deletion races
      // ahead of an api-file restore, the dev server briefly sees an import
      // pointing at a missing module and fails compilation. On Windows that
      // failure can stick in Turbopack's generated workflow outputs, and every
      // subsequent step request returns 500.
      const toRestore = restoreFiles.filter((item) => item.content !== '');
      const toDelete = restoreFiles.filter((item) => item.content === '');
      await Promise.all(
        toRestore.map((item) => fs.writeFile(item.path, item.content))
      );
      if (toDelete.length > 0) {
        await prewarm();
      }
      await Promise.all(toDelete.map((item) => fs.unlink(item.path)));
      await Promise.all(
        restoreDirectories.map((dir) =>
          fs.rm(dir, { recursive: true, force: true })
        )
      );
      await prewarm();
      restoreFiles.length = 0;
      restoreDirectories.length = 0;
    }, CLEANUP_HOOK_TIMEOUT_MS);

    test('should rebuild on workflow change', { timeout: 70_000 }, async () => {
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
        timeoutMs: usesNextFlowRoute ? 50_000 : 25_000,
        check: async () => {
          if (usesNextFlowRoute) {
            const manifestFunctionNames =
              await readManifestWorkflowFunctionNames();
            expect(manifestFunctionNames).toContain('myNewWorkflow');
            return;
          }

          const workflowContent = await readGeneratedWorkflowOutput();
          expect(workflowContent).toContain('myNewWorkflow');
        },
      });
    });

    test('should rebuild on step change', { timeout: 70_000 }, async () => {
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
      await pollUntil({
        description: 'generated step outputs to include myNewStep',
        timeoutMs: usesNextFlowRoute ? 50_000 : 25_000,
        check: async () => {
          const stepRouteContent = await readFileIfExists(generatedStep);
          if (stepRouteContent?.includes('myNewStep')) {
            return;
          }

          // Next flow-route builders regenerate manifest.json on every
          // rebuild. The bundled file may not preserve function names as
          // plain text.
          if (usesNextFlowRoute) {
            const manifestFunctionNames = await readManifestStepFunctionNames();
            expect(manifestFunctionNames).toContain('myNewStep');
            return;
          }

          throw new Error('myNewStep not found in generated step outputs');
        },
      });
    });

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
      { timeout: 60_000 },
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
      { timeout: 70_000 },
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
          timeoutMs: 50_000,
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
