import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('NextDeferredBuilder', () => {
  let testDir: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    testDir = join(process.cwd(), '.test-deferred-builder');
    await mkdir(testDir, { recursive: true });
    consoleLogSpy = vi.spyOn(console, 'log');
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    await rm(testDir, { recursive: true, force: true });
  });

  it('should not perform eager workflow discovery during initialization', async () => {
    // Create a test workflow file
    const workflowsDir = join(testDir, 'workflows');
    await mkdir(workflowsDir, { recursive: true });
    const testWorkflowPath = join(workflowsDir, 'test.ts');
    await writeFile(
      testWorkflowPath,
      `
      "use workflow";
      export async function testWorkflow() {
        return "test";
      }
      `,
      'utf-8'
    );

    // Create a cache file to simulate having cache
    const cacheDir = join(testDir, '.next', 'cache');
    await mkdir(cacheDir, { recursive: true });
    await writeFile(
      join(cacheDir, 'workflows.json'),
      JSON.stringify({
        workflowFiles: [testWorkflowPath],
        stepFiles: [],
      }),
      'utf-8'
    );

    // Import the builder
    const { getNextBuilderDeferred } = await import('./builder-deferred.js');
    const NextDeferredBuilder = await getNextBuilderDeferred();

    // Create an instance with test config
    const builder = new NextDeferredBuilder({
      dirs: ['workflows'],
      workingDir: testDir,
      buildTarget: 'next',
      stepsBundlePath: '',
      workflowsBundlePath: '',
      webhookBundlePath: '',
      distDir: '.next',
    });

    // Clear any logs from builder instantiation
    consoleLogSpy.mockClear();

    // Call build which triggers initializeDiscoveryState
    await builder.build();

    // Check that "Discovering workflow directives" log was NOT printed
    // In deferred mode, discovery only happens via loader socket notifications
    const discoveryLogs = consoleLogSpy.mock.calls.filter((call) =>
      call.some((arg) =>
        String(arg).includes('Discovering workflow directives')
      )
    );

    expect(discoveryLogs).toHaveLength(0);
  });
});
