import fs from 'fs/promises';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';
import { getWorkbenchAppPath } from './utils';

export interface DevTestConfig {
  generatedStepPath: string;
  generatedWorkflowPath: string;
  apiFilePath: string;
  apiFileImportPath: string;
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
    const generatedStep = path.join(appPath, finalConfig.generatedStepPath);
    const generatedWorkflow = path.join(
      appPath,
      finalConfig.generatedWorkflowPath
    );
    const testWorkflowFile = finalConfig.testWorkflowFile ?? '3_streams.ts';
    const workflowsDir = finalConfig.workflowsDir ?? 'workflows';
    const restoreFiles: Array<{ path: string; content: string }> = [];

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

      while (true) {
        try {
          const workflowContent = await fs.readFile(generatedWorkflow, 'utf8');
          expect(workflowContent).toContain('myNewWorkflow');
          break;
        } catch (_) {
          await new Promise((res) => setTimeout(res, 1_000));
        }
      }
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

      while (true) {
        try {
          const workflowContent = await fs.readFile(generatedStep, 'utf8');
          expect(workflowContent).toContain('myNewStep');
          break;
        } catch (_) {
          await new Promise((res) => setTimeout(res, 1_000));
        }
      }
    });

    test(
      'should rebuild on adding workflow file',
      { timeout: 30_000 },
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

        while (true) {
          try {
            const workflowContent = await fs.readFile(
              generatedWorkflow,
              'utf8'
            );
            expect(workflowContent).toContain('newWorkflowFile');
            break;
          } catch (_) {
            await new Promise((res) => setTimeout(res, 1_000));
          }
        }
      }
    );
  });
}

// Run tests with environment-based config if this file is executed directly
if (process.env.DEV_TEST_CONFIG) {
  createDevTests();
}
