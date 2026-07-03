import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createBuildOutputApiRoutes,
  getBuildOutputStaticManifestDir,
} from './vercel-build-output-api.js';

describe('Vercel Build Output API workflow routes', () => {
  it('prefixes flow and webhook routes with the framework base path', () => {
    expect(createBuildOutputApiRoutes('/app/')).toEqual([
      {
        src: '^/app/\\.well-known\\/workflow\\/v1\\/flow\\/?$',
        dest: '/.well-known/workflow/v1/flow',
      },
      {
        src: '^/app/\\.well-known\\/workflow\\/v1\\/webhook\\/([^\\/]+?)\\/?$',
        dest: '/.well-known/workflow/v1/webhook/[token]',
      },
    ]);
  });

  it('keeps root routes root-relative', () => {
    expect(createBuildOutputApiRoutes('').map((route) => route.src)).toEqual([
      '^/\\.well-known\\/workflow\\/v1\\/flow\\/?$',
      '^/\\.well-known\\/workflow\\/v1\\/webhook\\/([^\\/]+?)\\/?$',
    ]);
  });

  it('places public manifests below the base path in static output', () => {
    expect(getBuildOutputStaticManifestDir('/tmp/output', '/app/')).toBe(
      join('/tmp/output', 'static/app/.well-known/workflow/v1')
    );
  });
});
