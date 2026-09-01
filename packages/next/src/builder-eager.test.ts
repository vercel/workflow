import { describe, expect, it } from 'vitest';
import { createNextEntrypointMatcher } from './builder-eager.js';

const pageExtensions = ['js', 'jsx', 'ts', 'tsx', 'mts', 'cts'];
const isNextEntrypoint = createNextEntrypointMatcher({
  pageExtensions,
  bundler: 'webpack',
  globalNotFound: false,
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
    'src/instrumentation-client.ts',
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
    'app/global-not-found.tsx',
    'mdx-components.tsx',
    'src/mdx-components.tsx',
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
      createNextEntrypointMatcher({
        pageExtensions: ['tsx', 'page.tsx'],
        bundler: 'webpack',
        globalNotFound: false,
      })('app/error.page.tsx')
    ).toBe(true);
  });

  it('supports Turbopack numbered metadata', () => {
    const isTurbopackEntrypoint = createNextEntrypointMatcher({
      pageExtensions,
      bundler: 'turbopack',
      globalNotFound: false,
    });

    expect(isTurbopackEntrypoint('app/blog/opengraph-image12.tsx')).toBe(true);
  });

  it('includes enabled optional conventions', () => {
    const isOptionalEntrypoint = createNextEntrypointMatcher({
      pageExtensions: [...pageExtensions, 'mdx'],
      bundler: 'webpack',
      globalNotFound: true,
    });

    expect(isOptionalEntrypoint('app/global-not-found.tsx')).toBe(true);
    expect(isOptionalEntrypoint('mdx-components.tsx')).toBe(true);
  });
});
