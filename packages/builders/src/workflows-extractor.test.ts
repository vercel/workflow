import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { serializeWorkflowBundle } from './workflow-bundle-module.js';
import { extractWorkflowGraphs } from './workflows-extractor.js';

describe('extractWorkflowGraphs', () => {
  let tempDir: string | undefined;

  afterEach(async () => {
    vi.restoreAllMocks();

    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
  });

  it('parses workflowCode template literals with unicode-escape identifiers', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'workflow-builders-'));
    const bundlePath = join(tempDir, 'workflow-bundle.js');
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});

    await writeFile(
      bundlePath,
      [
        'const workflowCode = `',
        'function workflow() {',
        '  var DEBURR_MAP = new Map(Object.entries({\\\\u00C6: "Ae"}));',
        '  return DEBURR_MAP;',
        '}',
        'workflow.workflowId = "workflow//./input.js//workflow";',
        '`;',
      ].join('\n')
    );

    await expect(extractWorkflowGraphs(bundlePath)).resolves.toEqual({
      './input.js': {
        workflow: expect.objectContaining({
          workflowId: 'workflow//./input.js//workflow',
        }),
      },
    });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('extracts step nodes when step proxies include pure annotations', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'workflow-builders-'));
    const bundlePath = join(tempDir, 'workflow-bundle.js');

    await writeFile(
      bundlePath,
      [
        'var stepOne = globalThis[/* @__PURE__ */ Symbol.for("WORKFLOW_USE_STEP")]("step//./input.ts//stepOne");',
        'async function testWorkflow(input) {',
        '  const output = await stepOne(input);',
        '  return output;',
        '}',
        'testWorkflow.workflowId = "workflow//./input.ts//testWorkflow";',
      ].join('\n')
    );

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

  it('extracts each lazy workflow source independently', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'workflow-builders-'));
    const bundlePath = join(tempDir, 'workflow-bundle.js');
    const bundlesDir = join(tempDir, 'workflow-bundles');
    await mkdir(bundlesDir);
    await writeFile(
      bundlePath,
      `const first = import('./workflow-bundles/0.mjs');
const second = import('./workflow-bundles/1.mjs');
const unrelated = './workflow-bundles/9.mjs';`
    );

    const bundle = (file: string, name: string) =>
      `function ${name}() { return ${JSON.stringify(file)}; }\n${name}.workflowId = "workflow//${file}//${name}";`;
    await Promise.all(
      ['./first.ts', './second.ts'].map((file, index) =>
        writeFile(
          join(bundlesDir, `${index}.mjs`),
          serializeWorkflowBundle(bundle(file, `workflow${index}`))
        )
      )
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
});
