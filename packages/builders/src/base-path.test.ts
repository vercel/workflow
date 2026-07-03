import { describe, expect, it } from 'vitest';
import {
  createBasePathRouteRegexPrefix,
  joinWorkflowBasePath,
  normalizeWorkflowBasePath,
} from './base-path.js';

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

  it('joins normalized base paths with route paths', () => {
    expect(joinWorkflowBasePath('/app/', '/.well-known/workflow/v1/flow')).toBe(
      '/app/.well-known/workflow/v1/flow'
    );
  });

  it('escapes base paths for framework route regexes', () => {
    expect(createBasePathRouteRegexPrefix('/app.v2/')).toBe('^/app\\.v2/');
  });
});
