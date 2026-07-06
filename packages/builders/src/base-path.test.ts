import { describe, expect, it } from 'vitest';
import { normalizeWorkflowBasePath } from './base-path.js';
import { createBuildOutputApiWorkflowRoutes } from './vercel-build-output-api.js';

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

  it('prefixes Build Output API route sources (regex-escaped) and destinations', () => {
    expect(createBuildOutputApiWorkflowRoutes('/app.v2/')).toEqual([
      {
        src: '^/app\\.v2/\\.well-known/workflow/v1/flow/?$',
        dest: '/app.v2/.well-known/workflow/v1/flow',
      },
      {
        src: '^/app\\.v2/\\.well-known/workflow/v1/webhook/([^/]+?)/?$',
        dest: '/app.v2/.well-known/workflow/v1/webhook/[token]',
      },
    ]);
    // Root-relative without a base path
    expect(createBuildOutputApiWorkflowRoutes('')[0]).toEqual({
      src: '^/\\.well-known/workflow/v1/flow/?$',
      dest: '/.well-known/workflow/v1/flow',
    });
  });
});
