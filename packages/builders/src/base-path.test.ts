import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createBasePathRouteRegexPrefix,
  normalizeWorkflowBasePath,
} from './base-path.js';
import {
  createBuildOutputApiWorkflowRoutes,
  getBuildOutputFunctionsPrefix,
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

describe('Vercel Build Output API workflow output', () => {
  it('prefixes route sources and destinations with the base path', () => {
    expect(createBuildOutputApiWorkflowRoutes('/app/')).toEqual([
      {
        src: '^/app/\\.well-known/workflow/v1/flow/?$',
        dest: '/app/.well-known/workflow/v1/flow',
      },
      {
        src: '^/app/\\.well-known/workflow/v1/webhook/([^/]+?)/?$',
        dest: '/app/.well-known/workflow/v1/webhook/[token]',
      },
    ]);
  });

  it('keeps routes root-relative without a base path', () => {
    expect(createBuildOutputApiWorkflowRoutes('')).toEqual([
      {
        src: '^/\\.well-known/workflow/v1/flow/?$',
        dest: '/.well-known/workflow/v1/flow',
      },
      {
        src: '^/\\.well-known/workflow/v1/webhook/([^/]+?)/?$',
        dest: '/.well-known/workflow/v1/webhook/[token]',
      },
    ]);
  });

  it('places functions below the base path so root-relative URLs 404 naturally', () => {
    expect(getBuildOutputFunctionsPrefix('/app/')).toBe(
      join('app', '.well-known/workflow/v1')
    );
    expect(getBuildOutputFunctionsPrefix('')).toBe(
      join('.well-known/workflow/v1')
    );
  });

  it('places public manifests below the base path in static output', () => {
    expect(getBuildOutputStaticManifestDir('/tmp/output', '/app/')).toBe(
      join('/tmp/output', 'static/app/.well-known/workflow/v1')
    );
  });
});
