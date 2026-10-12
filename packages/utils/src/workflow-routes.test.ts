import { afterEach, describe, expect, it } from 'vitest';
import {
  createAppRouteUrl,
  createWorkflowBaseUrl,
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

  it('builds an app route URL under the same base path as the flow route', () => {
    expect(createAppRouteUrl('http://localhost:3000', '/api/agent/queue')).toBe(
      'http://localhost:3000/api/agent/queue'
    );
    setWorkflowBasePath('/base');
    const baseUrl = createWorkflowBaseUrl('http://localhost:3000/');
    expect(createAppRouteUrl(baseUrl, '/api/agent/queue')).toBe(
      'http://localhost:3000/base/api/agent/queue'
    );
    expect(createWorkflowUrl(baseUrl, { type: 'flow' })).toBe(
      'http://localhost:3000/base/.well-known/workflow/v1/flow'
    );
    expect(() => createAppRouteUrl(baseUrl, 'api/agent/queue')).toThrow(
      TypeError
    );
  });

  it('rejects the retired standalone step route at runtime', () => {
    expect(() =>
      createWorkflowUrl('https://example.com', { type: 'step' } as never)
    ).toThrow('Unsupported workflow route: step');
  });
});
