import { IN_PROCESS_QUEUE_HANDLER } from '@workflow/world';

const NORMALIZE_REQUEST_CODE = `
async function normalizeRequest(request) {
  const options = {
    method: request.method,
    headers: new Headers(request.headers)
  };
  if (!['GET', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'].includes(request.method)) {
    options.body = await request.arrayBuffer();
  }
  return new Request(request.url, options);
}
`;

/**
 * The flow route of a framework whose route handlers take `{ request }`
 * (SvelteKit, Astro): one `workflowEntrypoint()` for the module's lifetime,
 * served through `normalizeRequest`, and exposing that entrypoint's
 * in-process entry on the exported `POST` so a World handed the module's
 * `POST` (`registerHandler`) delivers in process, as it does with the
 * generated route of every other framework. `workflowEntrypointCall` is the
 * `workflowEntrypoint(...)` expression; `trailer` is appended as is.
 */
export function createWrappedWorkflowRouteCode(
  workflowEntrypointCall: string,
  trailer = ''
): string {
  return `${NORMALIZE_REQUEST_CODE}
const workflowRoute = ${workflowEntrypointCall};
export const POST = Object.assign(
  async ({ request }) => workflowRoute(await normalizeRequest(request)),
  // The in-process entry a World's queue delivers to (IN_PROCESS_QUEUE_HANDLER
  // in @workflow/world).
  { [${IN_PROCESS_QUEUE_HANDLER_CODE}]: workflowRoute[${IN_PROCESS_QUEUE_HANDLER_CODE}] }
);${trailer}`;
}

/**
 * The expression generated code uses for the flow route's in-process entry
 * key, `IN_PROCESS_QUEUE_HANDLER` from `@workflow/world`, so a generated
 * module needs no import for it.
 */
export const IN_PROCESS_QUEUE_HANDLER_CODE = `Symbol.for(${JSON.stringify(IN_PROCESS_QUEUE_HANDLER.description)})`;

export { NORMALIZE_REQUEST_CODE };
