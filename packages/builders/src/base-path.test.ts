import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createBasePathRouteRegexPrefix,
  normalizeWorkflowBasePath,
} from './base-path.js';
import {
  createBuildOutputApiRootBlockRoutes,
  createBuildOutputApiWorkflowRoutes,
  getBuildOutputStaticManifestDir,
} from './vercel-build-output-api.js';

describe('workflow base paths', () => {
  it.each([
    [undefined, ''],
    ['', ''],
    ['/', ''],
    ['/app', '/app'],
    ['/app/', '/app'],
    ['app/', '/app'],
  ])('normalizes %j to %j', (input, expected) => {
    expect(normalizeWorkflowBasePath(input)).toBe(expected);
  });

  it('escapes base paths for framework route regexes', () => {
    expect(createBasePathRouteRegexPrefix('/app.v2/')).toBe('^/app\\.v2/');
  });
});

describe('Vercel Build Output API workflow routes', () => {
  it('prefixes public route sources with the base path, keeping internal destinations', () => {
    expect(createBuildOutputApiWorkflowRoutes('/app/')).toEqual([
      {
        src: '^/app/\\.well-known/workflow/v1/flow/?$',
        dest: '/.well-known/workflow/v1/flow',
      },
      {
        src: '^/app/\\.well-known/workflow/v1/webhook/([^/]+?)/?$',
        dest: '/.well-known/workflow/v1/webhook/[token]',
      },
    ]);
  });

  it('keeps route sources root-relative without a base path', () => {
    expect(
      createBuildOutputApiWorkflowRoutes('').map((route) => route.src)
    ).toEqual([
      '^/\\.well-known/workflow/v1/flow/?$',
      '^/\\.well-known/workflow/v1/webhook/([^/]+?)/?$',
    ]);
  });

  it('only blocks root workflow routes when a base path is configured', () => {
    expect(createBuildOutputApiRootBlockRoutes('')).toEqual([]);
    expect(
      createBuildOutputApiRootBlockRoutes('/app/').map((route) => route.status)
    ).toEqual([404, 404, 404]);
  });

  it('places public manifests below the base path in static output', () => {
    expect(getBuildOutputStaticManifestDir('/tmp/output', '/app/')).toBe(
      join('/tmp/output', 'static/app/.well-known/workflow/v1')
    );
  });
});
