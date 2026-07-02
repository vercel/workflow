import { afterEach, describe, expect, it } from 'vitest';
import {
  createWorkflowBaseUrl,
  createWorkflowHealthEndpoint,
  createWorkflowHealthUrl,
  createWorkflowManifestUrl,
  createWorkflowRouteUrl,
  createWorkflowWebhookUrl,
  setWorkflowBasePath,
} from './workflow-routes.js';

describe('workflow routes', () => {
  afterEach(() => {
    setWorkflowBasePath(undefined);
  });

  it('prefixes workflow URLs with the configured base path', () => {
    setWorkflowBasePath('/v2');

    expect(createWorkflowBaseUrl('https://example.com')).toBe(
      'https://example.com/v2'
    );
    expect(createWorkflowRouteUrl('http://localhost:3000/v2', 'flow')).toBe(
      'http://localhost:3000/v2/.well-known/workflow/v1/flow'
    );
    expect(createWorkflowHealthEndpoint()).toBe(
      '/v2/.well-known/workflow/v1/flow?__health'
    );
    expect(createWorkflowHealthUrl('http://localhost:3000/v2')).toBe(
      'http://localhost:3000/v2/.well-known/workflow/v1/flow?__health'
    );
    expect(createWorkflowManifestUrl('http://localhost:3000/v2')).toBe(
      'http://localhost:3000/v2/.well-known/workflow/v1/manifest.json'
    );
    expect(createWorkflowWebhookUrl('http://localhost:3000/v2', 'a/b')).toBe(
      'http://localhost:3000/v2/.well-known/workflow/v1/webhook/a%2Fb'
    );
  });

  it('rejects invalid base paths', () => {
    expect(() => setWorkflowBasePath('v2')).toThrow(
      'Invalid workflow basePath: v2'
    );
    expect(() => setWorkflowBasePath('/v2/')).toThrow(
      'Invalid workflow basePath: /v2/'
    );
    expect(() => setWorkflowBasePath('/v2?x=1')).toThrow(
      'Invalid workflow basePath: /v2?x=1'
    );
  });
});
