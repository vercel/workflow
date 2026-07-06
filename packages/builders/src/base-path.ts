const REGEXP_SPECIAL_CHARS = /[.*+?^${}()|[\]\\]/g;

export function normalizeWorkflowBasePath(
  basePath: string | undefined
): string {
  if (!basePath || basePath === '/') {
    return '';
  }

  const withoutTrailingSlash = basePath.replace(/\/+$/, '');

  if (!withoutTrailingSlash) {
    return '';
  }

  return withoutTrailingSlash.startsWith('/')
    ? withoutTrailingSlash
    : `/${withoutTrailingSlash}`;
}

export function joinWorkflowBasePath(
  basePath: string | undefined,
  path: string
): string {
  return `${normalizeWorkflowBasePath(basePath)}${path}`;
}

export function createWorkflowBasePathRuntimeCode(basePath: string): string {
  return `globalThis[Symbol.for('@workflow/core/basePath')] = ${JSON.stringify(basePath)};`;
}

export function createBasePathRouteRegexPrefix(
  basePath: string | undefined
): string {
  const normalized = normalizeWorkflowBasePath(basePath);
  return normalized ? `^${escapeRegExp(normalized)}/` : '^/';
}

function escapeRegExp(value: string): string {
  return value.replace(REGEXP_SPECIAL_CHARS, '\\$&');
}
