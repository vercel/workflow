import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findNextEntrypoints } from './builder-eager.js';

const pageExtensions = ['js', 'jsx', 'ts', 'tsx'];

describe('findNextEntrypoints', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(
      join(await realpath(tmpdir()), 'workflow-next-')
    );
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  const createFile = async (path: string) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '');
  };

  const discover = async (extensions = pageExtensions) => {
    const files = await findNextEntrypoints({
      workingDir: projectDir,
      pageExtensions: extensions,
    });
    return files.map((file) =>
      relative(projectDir, file).replaceAll('\\', '/')
    );
  };

  it('uses root app and pages directories when both root and src exist', async () => {
    const included = [
      'app/page.tsx',
      'app/dashboard/error.tsx',
      'app/@modal/default.tsx',
      'app/blog/opengraph-image.tsx',
      'app/blog/opengraph-image1.tsx',
      'app/global-error.tsx',
      'app/robots.ts',
      'pages/index.tsx',
      'pages/api/run.ts',
      'instrumentation.ts',
      'proxy.ts',
      'mdx-components.tsx',
    ];
    const excluded = [
      'app/component.tsx',
      'app/error.test.tsx',
      'app/_components/error.tsx',
      'app/blog/global-error.tsx',
      'app/blog/robots.ts',
      'app/blog/opengraph-image12.tsx',
      'app/icon.png',
      'app/.well-known/workflow/v1/flow/route.ts',
      'pages/types.d.ts',
      'src/app/page.tsx',
      'src/pages/index.tsx',
      'src/instrumentation-client.ts',
      'src/mdx-components.js',
    ];
    await Promise.all(
      [...included, ...excluded].map((file) =>
        createFile(join(projectDir, file))
      )
    );

    expect(await discover()).toEqual(included.sort());
  });

  it('uses src conventions when the routers live in src', async () => {
    const included = [
      'src/app/page.tsx',
      'src/pages/index.tsx',
      'src/instrumentation-client.ts',
      'src/mdx-components.js',
    ];
    const excluded = ['instrumentation.ts', 'mdx-components.tsx'];
    await Promise.all(
      [...included, ...excluded].map((file) =>
        createFile(join(projectDir, file))
      )
    );

    expect(await discover()).toEqual(included.sort());
  });

  it('discovers configured and compound page extensions', async () => {
    const included = [
      'app/page.mdx',
      'app/page.page.tsx',
      'app/error.page.tsx',
      'app/opengraph-image1.mdx',
      'pages/docs.mdx',
      'pages/docs.page.tsx',
      'proxy.mdx',
      'mdx-components.tsx',
    ];
    const excluded = [
      'app/page.tsx',
      'app/opengraph-image12.mdx',
      'pages/docs.tsx',
    ];
    await Promise.all(
      [...included, ...excluded].map((file) =>
        createFile(join(projectDir, file))
      )
    );

    expect(await discover(['mdx', 'page.tsx'])).toEqual(included.sort());
  });
});
