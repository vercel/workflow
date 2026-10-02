/**
 * Identity of the workflow routes, shared by everything that has to recognise
 * them from the outside: the body-parser bypass, the guard helper an
 * application uses to let queue deliveries through its own auth, and the
 * controller's own route declaration.
 */

import type { ExecutionContext } from '@nestjs/common';

/**
 * Path the {@link WorkflowController} is mounted at, without a leading slash so
 * it can be handed to `@Controller()` directly.
 */
export const WORKFLOW_ROUTE_PREFIX = '.well-known/workflow/v1';

/**
 * The same path as a slash-delimited segment, which is what a URL is matched
 * against. Matching the segment rather than the start of the path means a
 * global prefix, a reverse-proxy sub-path or a versioning segment in front of
 * it does not defeat the check.
 */
const WORKFLOW_ROUTE_SEGMENT = `/${WORKFLOW_ROUTE_PREFIX}/`;

/**
 * Whether a request path addresses one of the workflow routes.
 *
 * Accepts a full URL or a path, with or without a query string.
 */
export function isWorkflowRoutePath(path: string | undefined | null): boolean {
  if (!path) return false;
  // A path may arrive with the query string attached (`req.url`), and a query
  // value could contain the segment. Compare the pathname only.
  const pathname = path.split('?')[0]?.split('#')[0] ?? '';
  return pathname.includes(WORKFLOW_ROUTE_SEGMENT);
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
  const http = context?.switchToHttp?.();
  if (!http) return false;
  return isWorkflowRoutePath(requestPath(http.getRequest()));
}
