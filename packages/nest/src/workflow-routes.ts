/**
 * Identity of the workflow routes, shared by everything that has to recognise
 * them from the outside: the body-parser bypass, the guard helper an
 * application uses to let queue deliveries through its own auth, and the
 * controller's own route declaration.
 */

import type { ExecutionContext } from '@nestjs/common';
import { normalizeBasePath } from './options.js';

/**
 * Path the {@link WorkflowController} is mounted at, without a leading slash so
 * it can be handed to `@Controller()` directly.
 */
export const WORKFLOW_ROUTE_PREFIX = '.well-known/workflow/v1';

/**
 * Static property {@link WorkflowController} carries, so a guard can recognise
 * the controller NestJS selected without importing the class. `Symbol.for`
 * keeps the check working when the application and `WorkflowModule` load
 * different copies of this package.
 */
export const WORKFLOW_CONTROLLER_MARKER = Symbol.for(
  '@workflow/nest/WorkflowController'
);

/**
 * Whether a request path addresses one of the workflow routes.
 *
 * Accepts a full URL or a path, with or without a query string. `globalPrefix`
 * is the NestJS global prefix the routes are served under (`'api'` or
 * `'/api'`), and the match is anchored to it: `/files/.well-known/workflow/v1/flow`
 * is an application route that happens to contain the segment, not a
 * workflow route.
 */
export function isWorkflowRoutePath(
  path: string | undefined | null,
  globalPrefix = ''
): boolean {
  if (!path) return false;
  // A path may arrive with the query string attached (`req.url`), and a query
  // value could contain the segment. Compare the pathname only.
  let pathname = path.split('?')[0]?.split('#')[0] ?? '';
  if (!pathname.startsWith('/')) {
    try {
      pathname = new URL(pathname).pathname;
    } catch {
      return false;
    }
  }
  const prefix = normalizeBasePath(globalPrefix);
  const routes = `${prefix}/${WORKFLOW_ROUTE_PREFIX}/`;
  return pathname.startsWith(routes) && pathname.length > routes.length;
}

type RequestLike = { originalUrl?: string; url?: string };

/** Pull the request path out of an Express or Fastify request object. */
export function requestPath(request: unknown): string | undefined {
  const req = request as RequestLike | null | undefined;
  if (!req) return undefined;
  // `originalUrl` first: Express rewrites `url` when the router is mounted on
  // a sub-path, and the prefix is exactly what the check needs to see.
  return req.originalUrl ?? req.url;
}

/**
 * Whether the request being handled is a Workflow SDK protocol request.
 *
 * Decided by the controller NestJS routed the request to, not by its URL, so a
 * wildcard application route cannot be made to look like a workflow route.
 *
 * The workflow routes carry queue deliveries and third-party webhooks, not end
 * users, so an application guard that authenticates users has to let them
 * through or every delivery is rejected and runs stop progressing:
 *
 * ```typescript
 * @Injectable()
 * export class AuthGuard implements CanActivate {
 *   canActivate(context: ExecutionContext) {
 *     if (isWorkflowRequest(context)) return true;
 *     // ...your own checks
 *   }
 * }
 * ```
 *
 * The workflow routes authenticate their own callers (queue deliveries are
 * signed, webhook tokens are single-use secrets), so letting them past an
 * application guard does not expose anything.
 *
 * Returns `false` for non-HTTP execution contexts (RPC, WebSockets), where
 * there is no workflow route to match.
 */
export function isWorkflowRequest(context: ExecutionContext): boolean {
  if (typeof context?.getType === 'function' && context.getType() !== 'http') {
    return false;
  }
  const controller = context?.getClass?.() as unknown as
    | Record<symbol, unknown>
    | undefined;
  return controller?.[WORKFLOW_CONTROLLER_MARKER] === true;
}
