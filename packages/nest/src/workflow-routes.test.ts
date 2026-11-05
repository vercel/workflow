import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { WorkflowController } from './workflow.controller.js';
import { isWorkflowRequest, isWorkflowRoutePath } from './workflow-routes.js';

describe('isWorkflowRoutePath', () => {
  it.each([
    ['/.well-known/workflow/v1/flow', '', true],
    ['/.well-known/workflow/v1/webhook/tok', '', true],
    ['https://example.test/.well-known/workflow/v1/flow', '', true],
    // The match is anchored to the global prefix the routes are served under.
    ['/api/.well-known/workflow/v1/flow', 'api', true],
    ['/api/.well-known/workflow/v1/flow', '/api/', true],
    ['/api/.well-known/workflow/v1/flow', '', false],
    ['/.well-known/workflow/v1/flow', 'api', false],
    // An application route that contains the segment is not a workflow route.
    ['/files/.well-known/workflow/v1/flow', '', false],
    ['/files/api/.well-known/workflow/v1/flow', 'api', false],
    // Query strings ride along on `req.url`.
    ['/.well-known/workflow/v1/flow?__health', '', true],
    // `manifest.json` is one segment deeper than the prefix, like the rest.
    ['/.well-known/workflow/v1/manifest.json', '', true],
    [undefined, '', false],
    [null, '', false],
    ['', '', false],
    ['/', '', false],
    ['/api/orders', 'api', false],
    // The prefix alone is not a route, and nothing is served there.
    ['/.well-known/workflow/v1', '', false],
    ['/.well-known/workflow/v1/', '', false],
    // A different well-known namespace.
    ['/.well-known/acme-challenge/x', '', false],
    // A query value that merely mentions the path must not count: the
    // comparison is against the pathname.
    ['/orders?next=/.well-known/workflow/v1/flow', '', false],
    ['/orders#/.well-known/workflow/v1/flow', '', false],
  ])('%o under prefix %o is a workflow route: %o', (path, prefix, expected) => {
    expect(isWorkflowRoutePath(path, prefix)).toBe(expected);
  });
});

function httpContext(controller: unknown, type = 'http'): ExecutionContext {
  return {
    getType: () => type,
    getClass: () => controller,
  } as unknown as ExecutionContext;
}

describe('isWorkflowRequest', () => {
  it('recognises the controller NestJS routed the request to', () => {
    expect(isWorkflowRequest(httpContext(WorkflowController))).toBe(true);
  });

  it('is false for an application controller, whatever the URL', () => {
    // A wildcard route such as `@Get('files/*path')` can be reached at
    // `/files/.well-known/workflow/v1/flow`; that request must still go
    // through the application's own guard.
    class FilesController {}
    expect(isWorkflowRequest(httpContext(FilesController))).toBe(false);
  });

  it('recognises a WorkflowController from another copy of the package', () => {
    // `Symbol.for` is realm-global, so a duplicate install still matches.
    class OtherCopy {
      static readonly [Symbol.for('@workflow/nest/WorkflowController')] = true;
    }
    expect(isWorkflowRequest(httpContext(OtherCopy))).toBe(true);
  });

  it('is false outside an HTTP context', () => {
    // A guard shared with a microservice or gateway sees contexts that have no
    // request at all.
    expect(isWorkflowRequest(httpContext(WorkflowController, 'rpc'))).toBe(
      false
    );
  });

  it('is false when the context cannot name a controller', () => {
    expect(isWorkflowRequest({} as ExecutionContext)).toBe(false);
  });
});
