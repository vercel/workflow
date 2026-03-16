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

import { createSwcPlugin } from './swc-esbuild-plugin.js';

const realTmpdir = realpathSync(tmpdir());

function writeFile(path: string, contents = ''): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents, 'utf-8');
}

describe('createSwcPlugin projectRoot', () => {
  let testRoot: string;

  beforeEach(() => {
    testRoot = mkdtempSync(join(realTmpdir, 'workflow-swc-plugin-'));
    applySwcTransformMock.mockReset();
    applySwcTransformMock.mockImplementation(
      async (_filename: string, source: string) => ({
        code: source,
        workflowManifest: {},
      })
    );
  });

  afterEach(() => {
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

  it('passes the explicit projectRoot through to applySwcTransform', async () => {
    const fixture = setupFixture();

    const result = await esbuild.build({
      entryPoints: [fixture.workflowFile],
      absWorkingDir: fixture.packageRoot,
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      plugins: [
        createSwcPlugin({
          mode: 'workflow',
          projectRoot: fixture.appRoot,
          workflowManifest: {},
        }),
      ],
    });

    expect(result.errors).toHaveLength(0);
    expect(applySwcTransformMock).toHaveBeenCalledWith(
      'src/internal/message/workflow/handle-message.ts',
      expect.stringContaining('"use workflow"'),
      'workflow',
      fixture.workflowFile,
      fixture.appRoot
    );
  });

  it('defaults the transform projectRoot to absWorkingDir', async () => {
    const fixture = setupFixture();

    const result = await esbuild.build({
      entryPoints: [fixture.workflowFile],
      absWorkingDir: fixture.packageRoot,
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      plugins: [
        createSwcPlugin({
          mode: 'workflow',
          workflowManifest: {},
        }),
      ],
    });

    expect(result.errors).toHaveLength(0);
    expect(applySwcTransformMock).toHaveBeenCalledWith(
      'src/internal/message/workflow/handle-message.ts',
      expect.stringContaining('"use workflow"'),
      'workflow',
      fixture.workflowFile,
      fixture.packageRoot
    );
  });
});
