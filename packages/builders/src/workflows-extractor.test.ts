import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  serializeWorkflowBundle,
  workflowBundleFileName,
} from './workflow-bundle-module.js';
import { extractWorkflowGraphs } from './workflows-extractor.js';

describe('extractWorkflowGraphs', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('extracts each lazy workflow source independently', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'workflow-builders-'));
    const bundlePath = join(tempDir, 'workflow-bundle.js');
    const bundlesDir = join(tempDir, 'workflow-bundles');
    await mkdir(bundlesDir);
    await writeFile(
      bundlePath,
      'const routeDoesNotNeedToDescribeItsLazyBundles = true;'
    );

    const bundle = (file: string, name: string) =>
      `function ${name}() { return ${JSON.stringify(file)}; }\n${name}.workflowId = "workflow//${file}//${name}";`;
    await Promise.all(
      ['./first.ts', './second.ts'].map((file, index) => {
        const code = bundle(file, `workflow${index}`);
        return writeFile(
          join(bundlesDir, workflowBundleFileName(code)),
          serializeWorkflowBundle(code)
        );
      })
    );

    await expect(extractWorkflowGraphs(bundlePath)).resolves.toEqual({
      './first.ts': {
        workflow0: expect.objectContaining({
          workflowId: 'workflow//./first.ts//workflow0',
        }),
      },
      './second.ts': {
        workflow1: expect.objectContaining({
          workflowId: 'workflow//./second.ts//workflow1',
        }),
      },
    });
  });

  it('rejects a missing lazy workflow bundle set', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'workflow-builders-'));
    const bundlePath = join(tempDir, 'workflow-bundle.js');
    await writeFile(bundlePath, 'const route = true;');
    await mkdir(join(tempDir, 'workflow-bundles'));

    await expect(extractWorkflowGraphs(bundlePath)).rejects.toThrow(
      'No lazy workflow bundles found'
    );
  });

  it('rejects a malformed lazy workflow bundle', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'workflow-builders-'));
    const bundlePath = join(tempDir, 'workflow-bundle.js');
    const bundlesDir = join(tempDir, 'workflow-bundles');
    await mkdir(bundlesDir);
    await writeFile(bundlePath, 'const workflowCode = {};');
    const malformedBundleFile =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.mjs';
    await writeFile(join(bundlesDir, malformedBundleFile), 'malformed');

    await expect(extractWorkflowGraphs(bundlePath)).rejects.toThrow(
      `Failed to extract workflow graph from lazy bundle "${malformedBundleFile}"`
    );
  });
});
