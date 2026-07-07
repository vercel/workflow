export const WORKFLOW_ROUTE_BASE = '/.well-known/workflow/v1';
const BASE_PATH_SYMBOL = Symbol.for('@workflow/core/basePath');
const globalConfig = globalThis as typeof globalThis &
  Record<symbol, string | undefined>;

export function setWorkflowBasePath(basePath: string | undefined): void {
  globalConfig[BASE_PATH_SYMBOL] = basePath ?? '';
}

function getWorkflowBasePath(): string {
  return globalConfig[BASE_PATH_SYMBOL] ?? '';
}

export function createWorkflowBaseUrl(origin: string): string {
  new URL(origin);
  return `${origin.replace(/[?#].*$/, '').replace(/\/+$/, '')}${getWorkflowBasePath()}`;
}

export type WorkflowUrlRoute =
  | { type: 'flow' | 'step' }
  | { type: 'manifest' }
  | { type: 'webhook'; token: string }
  | { type: 'health' };

export function createWorkflowUrl(
  baseUrl: string,
  route: WorkflowUrlRoute
): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${WORKFLOW_ROUTE_BASE}/${getWorkflowRouteEndpoint(route)}`;
  url.search = route.type === 'health' ? '__health' : '';
  url.hash = '';
  return url.toString();
}

function getWorkflowRouteEndpoint(route: WorkflowUrlRoute): string {
  switch (route.type) {
    case 'flow':
    case 'health':
      return 'flow';
    case 'step':
      return 'step';
    case 'manifest':
      return 'manifest.json';
    case 'webhook':
      return `webhook/${encodeURIComponent(route.token)}`;
  }
  const exhaustive: never = route;
  return exhaustive;
}

export function createWorkflowHealthEndpoint(): string {
  return `${getWorkflowBasePath()}${WORKFLOW_ROUTE_BASE}/flow?__health`;
}
