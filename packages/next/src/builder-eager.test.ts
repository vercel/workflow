import { describe, expect, it } from 'vitest';
import { isNextEntrypoint } from './builder-eager.js';

const pageExtensions = ['js', 'jsx', 'ts', 'tsx'];

describe('isNextEntrypoint', () => {
  it.each([
    'pages/index.tsx',
    'src/pages/api/run.ts',
    'app/page.tsx',
    'app/dashboard/error.tsx',
    'app/@modal/default.tsx',
    'app/blog/opengraph-image12.tsx',
    'app/global-error.tsx',
    'src/app/robots.ts',
    'instrumentation.ts',
    'src/instrumentation-client.ts',
    'proxy.ts',
    'mdx-components.tsx',
    'src/mdx-components.js',
  ])('includes %s', (entry) => {
    expect(isNextEntrypoint(entry, pageExtensions)).toBe(true);
  });

  it.each([
    'app/component.tsx',
    'app/error.test.tsx',
    'app/_components/error.tsx',
    'src/app/_draft/loading.tsx',
    'app/blog/global-error.tsx',
    'app/blog/robots.ts',
    'src/random.ts',
    'app/page.vue',
  ])('excludes %s', (entry) => {
    expect(isNextEntrypoint(entry, pageExtensions)).toBe(false);
  });

  it('supports compound page extensions', () => {
    expect(isNextEntrypoint('app/error.page.tsx', ['tsx', 'page.tsx'])).toBe(
      true
    );
  });
});
