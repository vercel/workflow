export const WORKFLOW_ROUTE_BASE = '/.well-known/workflow/v1';
const BASE_PATH_SYMBOL = Symbol.for('@workflow/base-path');
const globalConfig = globalThis as typeof globalThis &
  Record<symbol, string | undefined>;

export function setWorkflowBasePath(basePath: string | undefined): void {
  if (!basePath) {
    globalConfig[BASE_PATH_SYMBOL] = '';
    return;
  }
  if (
    basePath === '/' ||
    !basePath.startsWith('/') ||
    basePath.endsWith('/') ||
    basePath.includes('?') ||
    basePath.includes('#')
  ) {
    throw new Error(`Invalid workflow basePath: ${basePath}`);
  }
  globalConfig[BASE_PATH_SYMBOL] = basePath;
}

function getWorkflowBasePath(): string {
  return globalConfig[BASE_PATH_SYMBOL] ?? '';
}

export function createWorkflowBaseUrl(origin: string): string {
  new URL(origin);
  return `${origin.replace(/[?#].*$/, '').replace(/\/+$/, '')}${getWorkflowBasePath()}`;
}

function createWorkflowEndpointUrl(baseUrl: string, endpoint: string): string {
  const url = new URL(baseUrl);
  url.pathname = `${url.pathname.replace(/\/+$/, '')}${WORKFLOW_ROUTE_BASE}/${endpoint}`;
  url.search = '';
  url.hash = '';
  return url.toString();
}

export function createWorkflowRouteUrl(
  baseUrl: string,
  route: 'flow' | 'step'
): string {
  return createWorkflowEndpointUrl(baseUrl, route);
}

export function createWorkflowManifestUrl(baseUrl: string): string {
  return createWorkflowEndpointUrl(baseUrl, 'manifest.json');
}

export function createWorkflowWebhookUrl(
  baseUrl: string,
  token: string
): string {
  return createWorkflowEndpointUrl(
    baseUrl,
    `webhook/${encodeURIComponent(token)}`
  );
}

export function createWorkflowHealthUrl(baseUrl: string): string {
  const url = new URL(createWorkflowRouteUrl(baseUrl, 'flow'));
  url.search = '__health';
  return url.toString();
}

export function createWorkflowHealthEndpoint(): string {
  return `${getWorkflowBasePath()}${WORKFLOW_ROUTE_BASE}/flow?__health`;
}
