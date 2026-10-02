import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { isWorkflowRequest, isWorkflowRoutePath } from './workflow-routes.js';

describe('isWorkflowRoutePath', () => {
  it.each([
    ['/.well-known/workflow/v1/flow', true],
    ['/.well-known/workflow/v1/webhook/tok', true],
    ['https://example.test/.well-known/workflow/v1/flow', true],
    // A global prefix, a reverse-proxy sub-path or a version segment can all
    // sit in front of the route.
    ['/api/.well-known/workflow/v1/flow', true],
    ['/proxied/api/.well-known/workflow/v1/flow', true],
    // Query strings ride along on `req.url`.
    ['/.well-known/workflow/v1/flow?__health', true],
    // `manifest.json` is one segment deeper than the prefix, like the rest.
    ['/.well-known/workflow/v1/manifest.json', true],
    [undefined, false],
    [null, false],
    ['', false],
    ['/', false],
    ['/api/orders', false],
    // The prefix alone is not a route, and nothing is served there.
    ['/.well-known/workflow/v1', false],
    // A different well-known namespace.
    ['/.well-known/acme-challenge/x', false],
    // A query value that merely mentions the path must not count: the
    // comparison is against the pathname.
    ['/orders?next=/.well-known/workflow/v1/flow', false],
    ['/orders#/.well-known/workflow/v1/flow', false],
  ])('%o is a workflow route: %o', (path, expected) => {
    expect(isWorkflowRoutePath(path)).toBe(expected);
  });
});

function httpContext(request: unknown, type = 'http'): ExecutionContext {
  return {
    getType: () => type,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('isWorkflowRequest', () => {
  it('recognises a workflow request from its path', () => {
    expect(
      isWorkflowRequest(httpContext({ url: '/.well-known/workflow/v1/flow' }))
    ).toBe(true);
  });

  it('prefers originalUrl, which keeps the mount prefix Express strips', () => {
    expect(
      isWorkflowRequest(
        httpContext({
          url: '/flow',
          originalUrl: '/api/.well-known/workflow/v1/flow',
        })
      )
    ).toBe(true);
  });

  it('is false for an application route', () => {
    expect(isWorkflowRequest(httpContext({ url: '/orders' }))).toBe(false);
  });

  it('is false outside an HTTP context', () => {
    // A guard shared with a microservice or gateway sees contexts that have no
    // request at all.
    expect(
      isWorkflowRequest(
        httpContext({ url: '/.well-known/workflow/v1/flow' }, 'rpc')
      )
    ).toBe(false);
  });

  it('is false when the context cannot produce a request', () => {
    expect(isWorkflowRequest({} as ExecutionContext)).toBe(false);
  });
});
