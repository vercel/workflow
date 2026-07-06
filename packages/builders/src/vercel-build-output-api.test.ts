import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createBuildOutputApiRootBlockRoutes,
  createBuildOutputApiRoutes,
  getBuildOutputStaticManifestDir,
} from './vercel-build-output-api.js';

describe('Vercel Build Output API workflow routes', () => {
  it('prefixes flow and webhook routes with the framework base path', () => {
    expect(createBuildOutputApiRoutes('/app/')).toEqual([
      {
        src: '^/\\.well-known\\/workflow\\/v1\\/flow\\/?$',
        status: 404,
      },
      {
        src: '^/\\.well-known\\/workflow\\/v1\\/webhook\\/([^\\/]+?)\\/?$',
        status: 404,
      },
      {
        src: '^/\\.well-known\\/workflow\\/v1\\/manifest\\.json\\/?$',
        status: 404,
      },
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

  it('only blocks root routes when a base path is configured', () => {
    expect(createBuildOutputApiRootBlockRoutes('')).toEqual([]);
    expect(createBuildOutputApiRootBlockRoutes('/app/')).toHaveLength(3);
  });
});
