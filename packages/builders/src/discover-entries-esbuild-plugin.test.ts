import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as esbuild from 'esbuild';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { applySwcTransformMock } = vi.hoisted(() => ({
  applySwcTransformMock: vi.fn(),
}));

vi.mock('./apply-swc-transform.js', () => ({
  applySwcTransform: applySwcTransformMock,
}));

import {
  createDiscoverEntriesPlugin,
  importParents,
} from './discover-entries-esbuild-plugin.js';

const realTmpdir = realpathSync(tmpdir());

function normalizeSlashes(path: string): string {
  return path.replace(/\\/g, '/');
}

function writeFile(path: string, contents = ''): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

describe('createDiscoverEntriesPlugin projectRoot', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(realTmpdir, 'workflow-discover-plugin-'));
    importParents.clear();
    applySwcTransformMock.mockReset();
    applySwcTransformMock.mockImplementation(
      async (_filename: string, source: string) => ({
        code: source,
        workflowManifest: {},
      })
    );
  });

  afterEach(() => {
    importParents.clear();
    rmSync(testRoot, { recursive: true, force: true });
  });

  function setupFixture() {
    const appRoot = join(testRoot, 'apps', 'chat');
    const packageRoot = join(testRoot, 'packages', 'vade');
    const workflowFile = join(
      packageRoot,
      'src',
      'internal',
      'message',
      'workflow',
      'handle-message.ts'
    );

    writeFile(
      workflowFile,
      `export async function handleMessageWorkflow(message) {
  "use workflow";

  return message;
}
`
    );

    return {
      appRoot,
      packageRoot,
      workflowFile,
    };
  }

  it('uses the explicit projectRoot during discovery transforms', async () => {
    const fixture = setupFixture();
    const normalizedWorkflowFile = normalizeSlashes(fixture.workflowFile);
    const state = {
      discoveredSteps: [],
      discoveredWorkflows: [],
      discoveredSerdeFiles: [],
    };

    const result = await esbuild.build({
      entryPoints: [fixture.workflowFile],
      absWorkingDir: fixture.packageRoot,
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      plugins: [createDiscoverEntriesPlugin(state, fixture.appRoot)],
    });

    expect(result.errors).toHaveLength(0);
    expect(state.discoveredWorkflows).toEqual([normalizedWorkflowFile]);
    expect(applySwcTransformMock).toHaveBeenCalledWith(
      normalizedWorkflowFile,
      expect.stringContaining('"use workflow"'),
      false,
      normalizedWorkflowFile,
      fixture.appRoot
    );
  });

  it('defaults discovery transforms to absWorkingDir when projectRoot is omitted', async () => {
    const fixture = setupFixture();
    const normalizedWorkflowFile = normalizeSlashes(fixture.workflowFile);
    const state = {
      discoveredSteps: [],
      discoveredWorkflows: [],
      discoveredSerdeFiles: [],
    };

    const result = await esbuild.build({
      entryPoints: [fixture.workflowFile],
      absWorkingDir: fixture.packageRoot,
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      plugins: [createDiscoverEntriesPlugin(state)],
    });

    expect(result.errors).toHaveLength(0);
    expect(state.discoveredWorkflows).toEqual([normalizedWorkflowFile]);
    expect(applySwcTransformMock).toHaveBeenCalledWith(
      normalizedWorkflowFile,
      expect.stringContaining('"use workflow"'),
      false,
      normalizedWorkflowFile,
      fixture.packageRoot
    );
  });
});
