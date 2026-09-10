/**
 * Options for {@link createWorkflowWebHandler}.
 */
export interface CreateWorkflowWebHandlerOptions {
  /**
   * Mount path the dashboard is served under (e.g. `"/_workflow"`). Routing and
   * asset URLs are reprefixed to this base. Defaults to `"/"` (root).
   */
  basename?: string;
}

/**
 * Create a framework-agnostic Web `Request` -> `Response` handler that serves
 * the Workflow observability UI (static client assets + React Router SSR)
 * in-process, suitable for mounting inside another server under `basename`.
 *
 * Requires `@workflow/web` to have been built (`build/` must exist); throws
 * otherwise.
 */
export function createWorkflowWebHandler(
  options?: CreateWorkflowWebHandlerOptions
): Promise<(request: Request) => Promise<Response>>;
