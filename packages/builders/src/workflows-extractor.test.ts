import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
});
