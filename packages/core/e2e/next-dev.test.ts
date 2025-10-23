import fs from 'fs/promises';
import path from 'path';
import { afterEach, describe, expect, test } from 'vitest';
import { getWorkbenchAppPath } from './utils';

describe('dev e2e', () => {
  const appPath = getWorkbenchAppPath();
  const generatedStep = path.join(
    appPath,
    'app',
    '.well-known/workflow/v1/step',
    'route.js'
  );
  const generatedWorkflow = path.join(
    appPath,
    'app',
    '.well-known/workflow/v1/flow',
    'route.js'
  );

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

  test('should rebuild on workflow change', { timeout: 10_000 }, async () => {
    const workflowFile = path.join(appPath, 'workflows', 'streams.ts');

    const content = await fs.readFile(workflowFile, 'utf8');

    await fs.writeFile(
      workflowFile,
      `
      ${content}
      
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

  test('should rebuild on step change', { timeout: 10_000 }, async () => {
    const stepFile = path.join(appPath, 'workflows', 'streams.ts');

    const content = await fs.readFile(stepFile, 'utf8');

    await fs.writeFile(
      stepFile,
      `
      ${content}
      
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
    { timeout: 10_000 },
    async () => {
      const workflowFile = path.join(appPath, 'workflows', 'new-workflow.ts');

      await fs.writeFile(
        workflowFile,
        `
      export async function newWorkflowFile() {
        'use workflow'
        return 'hello world'
      }
    `
      );
      restoreFiles.push({ path: workflowFile, content: '' });
      const chatApiFile = path.join(appPath, 'app', 'api', 'chat', 'route.ts');

      const chatApiFileContent = await fs.readFile(chatApiFile, 'utf8');
      restoreFiles.push({ path: chatApiFile, content: chatApiFileContent });

      await fs.writeFile(
        chatApiFile,
        `
      import '../../../workflows/new-workflow';
      ${chatApiFileContent}
      `
      );

      while (true) {
        try {
          const workflowContent = await fs.readFile(generatedWorkflow, 'utf8');
          expect(workflowContent).toContain('newWorkflowFile');
          break;
        } catch (_) {
          await new Promise((res) => setTimeout(res, 1_000));
        }
      }
    }
  );
});
