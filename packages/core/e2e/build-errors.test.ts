import { exec as execOriginal } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { promisify } from 'util';
import { afterEach, describe, expect, test } from 'vitest';
import { getWorkbenchAppPath } from './utils';

const exec = promisify(execOriginal);

/**
 * These tests verify that build-time error messages for Node.js module
 * violations in workflow files are helpful and actionable.
 *
 * Note: This test creates a temporary workflow file, regenerates the
 * workflows registry to include it, then runs the build expecting it to fail.
 */
describe('build error messages', () => {
  const restoreFiles: Array<{ path: string; content: string | null }> = [];
  const appName = process.env.APP_NAME ?? 'nextjs-turbopack';
  const appPath = getWorkbenchAppPath(appName);

  afterEach(async () => {
    // Restore files in reverse order to handle dependencies
    for (const item of restoreFiles.reverse()) {
      if (item.content === null) {
        await fs.unlink(item.path).catch(() => {});
      } else {
        await fs.writeFile(item.path, item.content);
      }
    }
    restoreFiles.length = 0;
    // previous failures can cause successive tests to fail
    await fs.rm(path.join(appPath, '.next'), { recursive: true, force: true });
  });

  /**
   * Helper to set up a test workflow file and run the build
   */
  async function setupAndBuild(
    appPath: string,
    filename: string,
    content: string
  ): Promise<{ buildError: Error | null; output: string }> {
    const badWorkflowPath = path.join(appPath, 'workflows', filename);

    await fs.writeFile(badWorkflowPath, content);
    restoreFiles.push({ path: badWorkflowPath, content: null });

    // Generate _workflows.ts if it doesn't exist (CI doesn't build workbenches first)
    const workflowsRegistryPath = path.join(appPath, '_workflows.ts');
    let originalRegistry: string | null = null;
    try {
      originalRegistry = await fs.readFile(workflowsRegistryPath, 'utf8');
    } catch {
      // File doesn't exist, generate it first
      await exec(
        'node ../scripts/generate-workflows-registry.js ./workflows ./_workflows.ts',
        { cwd: appPath }
      );
      originalRegistry = await fs.readFile(workflowsRegistryPath, 'utf8');
    }
    restoreFiles.push({
      path: workflowsRegistryPath,
      content: originalRegistry,
    });

    // Regenerate the workflows registry to include our test file
    await exec(
      'node ../scripts/generate-workflows-registry.js ./workflows ./_workflows.ts',
      { cwd: appPath }
    );

    // Run the build and expect it to fail
    let buildError: Error | null = null;
    let stderr = '';
    let stdout = '';

    try {
      const result = await exec('pnpm build', {
        cwd: appPath,
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error: any) {
      buildError = error;
      stdout = error.stdout || '';
      stderr = error.stderr || '';
    }

    return { buildError, output: stdout + stderr };
  }

  test(
    'should show helpful error when using Node.js module in workflow',
    { timeout: 60_000 },
    async () => {
      // Note: filename must NOT start with _ (those are skipped by registry generator)
      const badWorkflowContent = `
import { readFileSync } from 'fs';

export async function nodeModuleViolationWorkflow() {
  'use workflow';
  // This should trigger the node module error
  const content = readFileSync('package.json', 'utf8');
  return content;
}
`;

      const { buildError, output } = await setupAndBuild(
        appPath,
        'test_node_violation.ts',
        badWorkflowContent
      );

      // The build should have failed
      expect(buildError).not.toBeNull();

      // Verify the new error message format for direct Node.js module usage
      expect(output).toContain(
        'You are attempting to use "fs" which is a Node.js module.'
      );

      // Verify the location information is present
      expect(output).toContain('test_node_violation.ts');

      // Verify the suggestion is present
      expect(output).toContain('Move this function into a step function');

      // Verify the error doc link is present
      expect(output).toContain(
        'useworkflow.dev/err/node-js-module-in-workflow'
      );
    }
  );

  // This test only runs on nextjs-turbopack where @vercel/blob is installed
  test.skipIf(
    process.env.APP_NAME && process.env.APP_NAME !== 'nextjs-turbopack'
  )(
    'should show top-level package name for external dependencies that use Node.js modules',
    { timeout: 60_000 },
    async () => {
      // @vercel/blob internally uses Node.js modules (via undici)
      // The error should show "@vercel/blob" not the internal Node.js module
      const badWorkflowContent = `
import { put } from '@vercel/blob';

export async function blobViolationWorkflow() {
  'use workflow';
  const result = await put('test.txt', 'hello', { access: 'public' });
  return result.url;
}
`;

      const { buildError, output } = await setupAndBuild(
        appPath,
        'test_blob_violation.ts',
        badWorkflowContent
      );

      // The build should have failed
      expect(buildError).not.toBeNull();

      // Verify error shows the top-level package name, not internal Node.js module
      expect(output).toContain(
        'You are attempting to use "@vercel/blob" which depends on Node.js modules.'
      );

      // Verify the location points to our test file
      expect(output).toContain('test_blob_violation.ts');

      // Verify the suggestion is present
      expect(output).toContain('Move this function into a step function');

      // Verify the error doc link is present
      expect(output).toContain(
        'useworkflow.dev/err/node-js-module-in-workflow'
      );
    }
  );

  test(
    'should show helpful error when using Bun module in workflow',
    { timeout: 60_000 },
    async () => {
      // Bun modules should show a different error message than Node.js modules
      const badWorkflowContent = `
import { serve } from 'bun';

export async function bunViolationWorkflow() {
  'use workflow';
  const server = serve({ port: 3000, fetch: () => new Response('ok') });
  return server.port;
}
`;

      const { buildError, output } = await setupAndBuild(
        appPath,
        'test_bun_violation.ts',
        badWorkflowContent
      );

      // The build should have failed
      expect(buildError).not.toBeNull();

      // Verify the error message mentions Bun specifically
      expect(output).toContain(
        'You are attempting to use "bun" which is a Bun module.'
      );

      // Verify the location information is present
      expect(output).toContain('test_bun_violation.ts');

      // Verify the suggestion is present
      expect(output).toContain('Move this function into a step function');
    }
  );

  test(
    'should report all violations when multiple Node.js modules are used',
    { timeout: 60_000 },
    async () => {
      // Using multiple Node.js modules should report errors for all of them
      const badWorkflowContent = `
import { readFileSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

export async function multipleViolationsWorkflow() {
  'use workflow';
  const content = readFileSync(join('/', 'package.json'), 'utf8');
  const hash = createHash('sha256').update(content).digest('hex');
  return hash;
}
`;

      const { buildError, output } = await setupAndBuild(
        appPath,
        'test_multiple_violations.ts',
        badWorkflowContent
      );

      // The build should have failed
      expect(buildError).not.toBeNull();

      // Verify all three violations are reported
      expect(output).toContain('"fs" which is a Node.js module');
      expect(output).toContain('"path" which is a Node.js module');
      expect(output).toContain('"crypto" which is a Node.js module');

      // Verify the location information is present for our file
      expect(output).toContain('test_multiple_violations.ts');
    }
  );
});
