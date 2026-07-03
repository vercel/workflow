import { describe, expect, it } from 'vitest';
import {
  createAstroBasePathGuard,
  createAstroWorkflowRoutes,
} from './builder.js';

describe('createAstroWorkflowRoutes', () => {
  it('uses Astro base for Vercel workflow route matching', () => {
    expect(createAstroWorkflowRoutes('/app/')).toEqual([
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

  it('omits route guards for root base', () => {
    expect(createAstroBasePathGuard('')).toBe('');
  });

  it('guards generated handlers from root requests when Astro base is set', () => {
    expect(createAstroBasePathGuard('/app')).toContain(
      'pathname.startsWith("/app/")'
    );
  });
});
