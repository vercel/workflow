import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as builders from '@workflow/builders';
import { describe, expect, it, vi } from 'vitest';
import {
  createNextEntrypointMatcher,
  getNextBuilderEager,
} from './builder-eager.js';

const pageExtensions = ['js', 'jsx', 'ts', 'tsx', 'mts', 'cts'];
const isNextEntrypoint = createNextEntrypointMatcher(pageExtensions);

describe('generated function duration', () => {
  it.each([
    [undefined, 'max'],
    ['max', 'max'],
    [300, 300],
    [1800, 1800],
  ] as const)('writes maxDuration %s as %s', async (configured, expected) => {
    vi.stubEnv('NODE_ENV', 'production');
    const outputDir = await mkdtemp(
      join(tmpdir(), 'workflow-function-config-')
    );
    try {
      await mkdir(join(outputDir, '.well-known/workflow/v1'), {
        recursive: true,
      });
      const Builder = await getNextBuilderEager(builders);
      // Exercise the real config writer without building an entire Next app.
      const builder = Object.create(Builder.prototype) as {
        config: { maxDuration: typeof configured };
        writeFunctionsConfig(outputDir: string): Promise<void>;
      };
      builder.config = { maxDuration: configured };
      await builder.writeFunctionsConfig(outputDir);
      const config = JSON.parse(
        await readFile(
          join(outputDir, '.well-known/workflow/v1/config.json'),
          'utf8'
        )
      );
      expect(config.version).toBe('0');
      expect(config.workflows.maxDuration).toBe(expected);
      expect(config.workflows.experimentalTriggers).toEqual([
        expect.objectContaining({ type: 'queue/v2beta', consumer: 'default' }),
      ]);
      expect(Object.keys(config)).toEqual(['version', 'workflows']);
    } finally {
      vi.unstubAllEnvs();
      await rm(outputDir, { recursive: true, force: true });
    }
  });
});

describe('isNextEntrypoint', () => {
  it.each([
    'pages/index.tsx',
    'pages/api/run.ts',
    'src/pages/api/run.ts',
    'app/page.tsx',
    'app/dashboard/error.tsx',
    'app/@modal/default.tsx',
    'app/blog/opengraph-image1.tsx',
    'app/global-error.tsx',
    'app/robots.ts',
    'src/app/robots.ts',
    'instrumentation.ts',
    'instrumentation-client.ts',
    'instrumentation-client.mjs',
    'proxy.ts',
    'mdx-components.tsx',
    'mdx-components.mjs',
    'src/instrumentation-client.ts',
    'src/mdx-components.tsx',
  ])('includes %s', (entry) => {
    expect(isNextEntrypoint(entry)).toBe(true);
  });

  it.each([
    'app/component.tsx',
    'app/error.test.tsx',
    'app/_components/error.tsx',
    'app/blog/global-error.tsx',
    'app/blog/robots.ts',
    'app/blog/opengraph-image12.tsx',
    'pages/types.d.ts',
    'pages/types.d.mts',
    'pages/types.d.cts',
    'app/page.d.ts',
    'app/page.vue',
  ])('excludes %s', (entry) => {
    expect(isNextEntrypoint(entry)).toBe(false);
  });

  it('supports compound page extensions', () => {
    expect(
      createNextEntrypointMatcher(['tsx', 'page.tsx'])('app/error.page.tsx')
    ).toBe(true);
  });
});
