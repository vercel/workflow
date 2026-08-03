import { afterEach, describe, expect, it } from 'vitest';
import {
  createWorkflowHealthEndpoint,
  createWorkflowUrl,
  setWorkflowBasePath,
} from './workflow-routes.js';

describe('workflow routes', () => {
  afterEach(() => {
    setWorkflowBasePath(undefined);
  });

  it('builds URLs for the combined flow route', () => {
    expect(createWorkflowUrl('https://example.com', { type: 'flow' })).toBe(
      'https://example.com/.well-known/workflow/v1/flow'
    );
    expect(createWorkflowUrl('https://example.com', { type: 'health' })).toBe(
      'https://example.com/.well-known/workflow/v1/flow?__health'
    );
  });

  it('applies a configured base path', () => {
    setWorkflowBasePath('/base');

    expect(createWorkflowHealthEndpoint()).toBe(
      '/base/.well-known/workflow/v1/flow?__health'
    );
  });

  it('rejects the retired standalone step route at runtime', () => {
    expect(() =>
      createWorkflowUrl('https://example.com', { type: 'step' } as never)
    ).toThrow('Unsupported workflow route: step');
  });
});
