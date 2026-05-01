import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeAll, describe, expect, test } from 'vitest';
import { getWorkbenchAppPath } from './utils';

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
    const appPath = getWorkbenchAppPath();
    const deploymentUrl = process.env.DEPLOYMENT_URL;
    const generatedStep = path.join(appPath, finalConfig.generatedStepPath);
    const generatedWorkflow = path.join(
      appPath,
      finalConfig.generatedWorkflowPath
    );
    const testWorkflowFile = finalConfig.testWorkflowFile ?? '3_streams.ts';
    const workflowsDir = finalConfig.workflowsDir ?? 'workflows';
    const usesDeferredBuilder = generatedStep.includes(
      path.join('.well-known', 'workflow', 'v1', 'step', 'route.js')
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
    const restoreFiles: Array<{ path: string; content: string }> = [];

    const fetchWithTimeout = (pathname: string) => {
      if (!deploymentUrl) {
        return Promise.resolve();
      }

      return fetch(new URL(pathname, deploymentUrl), {
        signal: AbortSignal.timeout(5_000),
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
          signal: AbortSignal.timeout(5_000),
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
    });

    afterEach(async () => {
      await Promise.all(
        restoreFiles.map(async (item) => {
          if (item.content === '') {
            await fs.unlink(item.path);
          } else {
            await fs.writeFile(item.path, item.content);
          }
        })
      );
      await prewarm();
      restoreFiles.length = 0;
    });

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

      await pollUntil({
        description: 'generated step outputs to include myNewStep',
        check: async () => {
          const stepRouteContent = await fs.readFile(generatedStep, 'utf8');
          if (stepRouteContent.includes('myNewStep')) {
            return;
          }

          // The deferred builder regenerates manifest.json on every rebuild.
          // Check the manifest for the new step function name.
          if (usesDeferredBuilder) {
            const manifestFunctionNames = await readManifestStepFunctionNames();
            expect(manifestFunctionNames).toContain('myNewStep');
            return;
          }

          throw new Error('myNewStep not found in generated step outputs');
        },
      });
    });

    test.skipIf(!usesDeferredBuilder)(
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

        await pollUntil({
          description:
            'manifest.json to include imported step hot-reload marker',
          timeoutMs: 50_000,
          check: async () => {
            await triggerWorkflowRun('importedStepOnlyWorkflow');
            const manifestFunctionNames = await readManifestStepFunctionNames();
            expect(manifestFunctionNames).toContain(marker);
          },
        });
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

    test.skipIf(!usesDeferredBuilder)(
      'should include steps discovered from workflow imports',
      { timeout: 30_000 },
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

        await pollUntil({
          description:
            'manifest.json to include discoveredViaWorkflowStep after discovery',
          timeoutMs: 25_000,
          check: async () => {
            await fetchWithTimeout('/api/chat');
            const manifestFunctionNames = await readManifestStepFunctionNames();
            expect(manifestFunctionNames).toContain(
              'discoveredViaWorkflowStep'
            );
          },
        });
      }
    );

    test.skipIf(!usesDeferredBuilder)(
      'should reference package step sources discovered via manifest entries',
      { timeout: 30_000 },
      async () => {
        await pollUntil({
          description:
            'generated step route to reference @workflow/ai package steps',
          timeoutMs: 25_000,
          check: async () => {
            await fetchWithTimeout('/api/chat');
            const manifestJson = await fs.readFile(
              workflowManifestPath,
              'utf8'
            );
            const manifest = JSON.parse(manifestJson) as {
              steps?: Record<string, unknown>;
            };
            const manifestStepFiles = Object.keys(manifest.steps || {});
            expect(
              manifestStepFiles.some((filePath) =>
                filePath.includes('ai/dist/agent/durable-agent.js')
              )
            ).toBe(true);

            // Package step sources are imported directly (not copied). Verify
            // the generated step route imports the @workflow/ai package or
            // otherwise references `durable-agent` via its resolved path.
            const stepRouteContent = await fs.readFile(generatedStep, 'utf8');
            expect(
              stepRouteContent.includes('@workflow/ai') ||
                stepRouteContent.includes('durable-agent')
            ).toBe(true);
          },
        });
      }
    );
  });
}

// Run tests with environment-based config if this file is executed directly
if (process.env.DEV_TEST_CONFIG) {
  createDevTests();
}
