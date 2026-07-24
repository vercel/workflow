import { describe, expect, it } from 'vitest';
import { normalizeWorkflowBasePath } from './base-path.js';
import { createBuildOutputApiWebhookRoute } from './vercel-build-output-api.js';

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

  it('prefixes the webhook route source (regex-escaped) and destination', () => {
    expect(createBuildOutputApiWebhookRoute('/app.v2/')).toEqual({
      src: '^/app\\.v2/\\.well-known/workflow/v1/webhook/([^/]+?)/?$',
      dest: '/app.v2/.well-known/workflow/v1/webhook/[token]',
    });
    // Root-relative without a base path
    expect(createBuildOutputApiWebhookRoute('')).toEqual({
      src: '^/\\.well-known/workflow/v1/webhook/([^/]+?)/?$',
      dest: '/.well-known/workflow/v1/webhook/[token]',
    });
  });
});
