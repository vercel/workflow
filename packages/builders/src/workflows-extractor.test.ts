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

  const routeFor = (files: string[]) =>
    files
      .map((file) => `const load = () => import('./workflow-bundles/${file}');`)
      .join('\n');

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

    const bundle = (file: string, name: string) =>
      `function ${name}() { return ${JSON.stringify(file)}; }\n${name}.workflowId = "workflow//${file}//${name}";`;
    const bundleFiles = await Promise.all(
      ['./first.ts', './second.ts'].map(async (file, index) => {
        const code = bundle(file, `workflow${index}`);
        const bundleFile = workflowBundleFileName(code);
        await writeFile(
          join(bundlesDir, bundleFile),
          serializeWorkflowBundle(code)
        );
        return bundleFile;
      })
    );
    const staleCode = bundle('./stale.ts', 'staleWorkflow');
    await writeFile(
      join(bundlesDir, workflowBundleFileName(staleCode)),
      serializeWorkflowBundle(staleCode)
    );
    await writeFile(bundlePath, routeFor(bundleFiles));

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

  it('extracts step nodes when step proxies include pure annotations', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'workflow-builders-'));
    const bundlePath = join(tempDir, 'workflow-bundle.js');
    const bundlesDir = join(tempDir, 'workflow-bundles');
    await mkdir(bundlesDir);
    const code = [
      'var stepOne = globalThis[/* @__PURE__ */ Symbol.for("WORKFLOW_USE_STEP")]("step//./input.ts//stepOne");',
      'async function testWorkflow(input) {',
      '  const output = await stepOne(input);',
      '  return output;',
      '}',
      'testWorkflow.workflowId = "workflow//./input.ts//testWorkflow";',
    ].join('\n');
    const bundleFile = workflowBundleFileName(code);
    await writeFile(
      join(bundlesDir, bundleFile),
      serializeWorkflowBundle(code)
    );
    await writeFile(bundlePath, routeFor([bundleFile]));

    await expect(extractWorkflowGraphs(bundlePath)).resolves.toEqual({
      './input.ts': {
        testWorkflow: expect.objectContaining({
          workflowId: 'workflow//./input.ts//testWorkflow',
          graph: expect.objectContaining({
            nodes: expect.arrayContaining([
              expect.objectContaining({
                type: 'step',
                data: expect.objectContaining({
                  label: 'stepOne',
                  stepId: 'step//./input.ts//stepOne',
                }),
              }),
            ]),
          }),
        }),
      },
    });
  });

  it('rejects a route without lazy workflow bundle references', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'workflow-builders-'));
    const bundlePath = join(tempDir, 'workflow-bundle.js');
    await writeFile(bundlePath, 'const route = true;');
    await mkdir(join(tempDir, 'workflow-bundles'));

    await expect(extractWorkflowGraphs(bundlePath)).rejects.toThrow(
      'No lazy workflow bundles referenced'
    );
  });

  it('rejects a referenced lazy workflow bundle that is missing', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'workflow-builders-'));
    const bundlePath = join(tempDir, 'workflow-bundle.js');
    const missingBundleFile = `${'0'.repeat(64)}.mjs`;
    await writeFile(bundlePath, routeFor([missingBundleFile]));
    await mkdir(join(tempDir, 'workflow-bundles'));

    await expect(extractWorkflowGraphs(bundlePath)).rejects.toThrow(
      `Failed to extract workflow graph from lazy bundle "${missingBundleFile}"`
    );
  });

  it('rejects a malformed lazy workflow bundle', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'workflow-builders-'));
    const bundlePath = join(tempDir, 'workflow-bundle.js');
    const bundlesDir = join(tempDir, 'workflow-bundles');
    await mkdir(bundlesDir);
    const malformedBundleFile =
      '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef.mjs';
    await writeFile(join(bundlesDir, malformedBundleFile), 'malformed');
    await writeFile(bundlePath, routeFor([malformedBundleFile]));

    await expect(extractWorkflowGraphs(bundlePath)).rejects.toThrow(
      `Failed to extract workflow graph from lazy bundle "${malformedBundleFile}"`
    );
  });
});
