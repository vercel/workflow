import { join } from 'node:path';
import {
  ensureWorkflowTargetWorldEnv,
  WORKFLOW_WORLD_TARGET_MODULE,
} from '@workflow/builders';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getLoaderSourceMapOptions,
  injectWorkflowTargetWorldImport,
} from './loader.ts';

describe('getLoaderSourceMapOptions', () => {
  it('emits source maps for app files and uses the upstream source map', () => {
    const upstreamMap = { version: 3, sources: ['input.ts'], mappings: '' };

    expect(
      getLoaderSourceMapOptions(
        join(process.cwd(), 'app', 'workflow.ts'),
        upstreamMap
      )
    ).toEqual({
      inputSourceMap: upstreamMap,
      sourceMaps: true,
      inlineSourcesContent: true,
    });
  });

  it('disables implicit input source map loading when app files have no upstream map', () => {
    expect(
      getLoaderSourceMapOptions(join(process.cwd(), 'app', 'workflow.ts'), null)
    ).toEqual({
      inputSourceMap: false,
      sourceMaps: true,
      inlineSourcesContent: true,
    });
  });

  it('does not emit source maps for node_modules files', () => {
    expect(
      getLoaderSourceMapOptions(
        join(
          process.cwd(),
          'node_modules',
          '.pnpm',
          'pkg@1.0.0',
          'node_modules',
          'pkg',
          'dist',
          'index.js'
        ),
        { version: 3, sources: ['index.js'], mappings: '' }
      )
    ).toEqual({
      inputSourceMap: false,
      sourceMaps: false,
      inlineSourcesContent: false,
    });
  });
});

describe('injectWorkflowTargetWorldImport', () => {
  const originalTargetWorld = process.env.WORKFLOW_TARGET_WORLD;

  afterEach(() => {
    if (originalTargetWorld === undefined) {
      delete process.env.WORKFLOW_TARGET_WORLD;
    } else {
      process.env.WORKFLOW_TARGET_WORLD = originalTargetWorld;
    }
  });

  it('statically replaces the core world-target import', async () => {
    process.env.WORKFLOW_TARGET_WORLD = 'local';

    await expect(
      injectWorkflowTargetWorldImport(
        "import * as targetWorldModule from '@workflow/core/runtime/world-target';",
        { ensureWorkflowTargetWorldEnv, WORKFLOW_WORLD_TARGET_MODULE }
      )
    ).resolves.toBe(
      "import * as targetWorldModule from '@workflow/world-local';"
    );
  });

  it('leaves unrelated imports unchanged', async () => {
    await expect(
      injectWorkflowTargetWorldImport("import { start } from 'workflow';")
    ).resolves.toBe("import { start } from 'workflow';");
  });
});
