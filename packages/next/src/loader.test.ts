import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { getLoaderSourceMapOptions } from './loader.ts';

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
